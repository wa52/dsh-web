import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './process.mjs';
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

export function createControlServer(runtime, { port = 4780 } = {}) {
  const streams = new Set();
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  const payload = () => runtime ? runtime.view() : { world: null, agents: ['codex', 'opencode', 'pi', 'dsh'].map(id => ({ id, availability: 'not-configured', roles: [], permissions: {}, runs: [], performance: {} })), running: false };
  const broadcast = () => { for (const stream of streams) stream.write(`data: ${JSON.stringify(payload())}\n\n`); };
  runtime?.on('state', broadcast);
  runtime?.on('run', broadcast);
  const server = http.createServer(async (req, res) => {
    const expectedHost = `127.0.0.1:${server.address()?.port ?? port}`;
    const origin = `http://${expectedHost}`;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== expectedHost) return json(403, { error: 'Invalid local Host' });
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, type] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(path.join(webRoot, file))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, payload());
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ready: true, configured: Boolean(runtime), running: runtime?.running ?? false });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (streams.size >= 16) return json(429, { error: 'Too many observers' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        streams.add(res); res.write(`data: ${JSON.stringify(payload())}\n\n`);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
        req.on('close', () => { streams.delete(res); clearInterval(heartbeat); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/artifact') {
        if (!runtime) return json(409, { error: 'No configured project' });
        return json(200, { text: await runtime.artifact(url.searchParams.get('path') ?? '') });
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['x-dsh-control'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Same-origin control request required' });
        if (!runtime) return json(409, { error: 'Start the server with --config <project.json>' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return json(413, { error: 'Request too large' }); }
        const body = raw ? JSON.parse(raw) : {};
        if (url.pathname === '/api/start') {
          if (runtime.running) return json(409, { error: 'Loop is already running' });
          const count = body.maxActions ?? runtime.config.maxActions ?? 10;
          if (!Number.isSafeInteger(count) || count < 1 || count > 100) return json(400, { error: 'Action budget must be 1..100' });
          void runtime.start({ maxActions: count }).catch(error => runtime.emit('loop-error', redact(error.message)));
          return json(202, { status: 'starting' });
        }
        if (url.pathname === '/api/pause') return json(200, runtime.pause());
        if (url.pathname === '/api/cancel') { await runtime.cancel(); return json(200, { status: 'canceled' }); }
      }
      json(404, { error: 'Not found' });
    } catch (error) { json(400, { error: redact(error.message) }); }
  });
  server.on('close', () => { runtime?.off('state', broadcast); runtime?.off('run', broadcast); for (const stream of streams) stream.end(); streams.clear(); });
  return server;
}
