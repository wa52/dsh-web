import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './process.mjs';
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

function isWebHost(value) {
  return value && typeof value.setMode === 'function' && typeof value.startNativeSession === 'function';
}

export function createControlServer(orchestrator, { port = 4780 } = {}) {
  const host = isWebHost(orchestrator) ? orchestrator : null;
  const legacyRuntime = host ? null : orchestrator;
  const streams = new Set();
  const nativeStreams = new Set();
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

  const projectPayload = () => (host ? host.projectRuntime : legacyRuntime)?.view() ?? { world: null, agents: ['codex', 'opencode', 'pi', 'dsh'].map(id => ({ id, availability: 'not-configured', roles: [], permissions: {}, runs: [], performance: {} })), running: false };
  const hostPayload = () => host ? host.view() : null;
  const payload = () => {
    if (host) return { host: hostPayload(), project: projectPayload() };
    return projectPayload();
  };

  const broadcast = () => { const data = payload(); for (const stream of streams) stream.write(`data: ${JSON.stringify(data)}\n\n`); };
  const broadcastNative = event => { for (const stream of nativeStreams) stream.write(`data: ${JSON.stringify(event)}\n\n`); };

  legacyRuntime?.on('state', broadcast);
  legacyRuntime?.on('run', broadcast);
  host?.on('mode', broadcast);
  host?.on('project-state', broadcast);
  host?.on('project-run', broadcast);
  host?.on('project-error', broadcast);
  const nativeListeners = new Map();
  for (const event of ['native-event', 'native-message', 'native-done', 'native-error', 'native-stopped', 'native-ready', 'native-close']) {
    const listener = data => { broadcastNative({ type: event.replace('native-', ''), data }); broadcast(); };
    nativeListeners.set(event, listener);
    host?.on(event, listener);
  }

  const server = http.createServer(async (req, res) => {
    const runtime = host ? host.projectRuntime : legacyRuntime;
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
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ready: true, configured: Boolean(runtime), running: runtime?.running ?? false, host: host ? host.view() : null });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (streams.size >= 16) return json(429, { error: 'Too many observers' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        streams.add(res); res.write(`data: ${JSON.stringify(payload())}\n\n`);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
        req.on('close', () => { streams.delete(res); clearInterval(heartbeat); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/native/events') {
        if (nativeStreams.size >= 16) return json(429, { error: 'Too many observers' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        nativeStreams.add(res); res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
        req.on('close', () => { nativeStreams.delete(res); clearInterval(heartbeat); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/artifact') {
        if (!runtime) return json(409, { error: 'No configured project' });
        return json(200, { text: await runtime.artifact(url.searchParams.get('path') ?? '') });
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['x-dsh-control'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Same-origin control request required' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return json(413, { error: 'Request too large' }); }
        const body = raw ? JSON.parse(raw) : {};

        // WebHost mode endpoints
        if (host) {
          if (url.pathname === '/api/mode') {
            const result = await host.setMode(body.mode);
            return json(200, result);
          }
          if (url.pathname === '/api/native/start') {
            const result = await host.startNativeSession(body);
            return json(200, result);
          }
          if (url.pathname === '/api/native/chat') {
            if (typeof body.prompt !== 'string' || !body.prompt.trim()) return json(400, { error: 'prompt is required' });
            const result = await host.nativeChat(body.prompt);
            return json(200, result);
          }
          if (url.pathname === '/api/native/stop') {
            const result = await host.stopNative();
            return json(200, result);
          }
          if (url.pathname === '/api/project/setup') {
            const result = await host.setupProject(body);
            return json(200, result);
          }
          if (url.pathname === '/api/project/config') {
            const result = await host.loadProjectFromState();
            return json(200, result);
          }
        }

        if (!runtime) return json(409, { error: 'Start the server with --config <project.json> or set up a project in the UI' });
        if (url.pathname === '/api/start') {
          if (runtime.running) return json(409, { error: 'Loop is already running' });
          const count = body.maxActions ?? runtime.config.maxActions ?? 10;
          if (!Number.isSafeInteger(count) || count < 1 || count > 100) return json(400, { error: 'Action budget must be 1..100' });
          if (host) await host.startProjectLoop(count);
          else void runtime.start({ maxActions: count }).catch(error => runtime.emit('loop-error', redact(error.message)));
          return json(202, { status: 'starting' });
        }
        if (url.pathname === '/api/pause') return json(200, host ? await host.pauseProject() : runtime.pause());
        if (url.pathname === '/api/cancel') {
          if (host) await host.cancelProject();
          else await runtime.cancel();
          return json(200, { status: 'canceled' });
        }
      }
      json(404, { error: 'Not found' });
    } catch (error) { json(400, { error: redact(error.message) }); }
  });
  server.on('close', () => {
    legacyRuntime?.off('state', broadcast); legacyRuntime?.off('run', broadcast);
    host?.off('mode', broadcast); host?.off('project-state', broadcast); host?.off('project-run', broadcast);
    host?.off('project-error', broadcast);
    for (const [event, listener] of nativeListeners) host?.off(event, listener);
    for (const stream of streams) stream.end(); streams.clear();
    for (const stream of nativeStreams) stream.end(); nativeStreams.clear();
  });
  return server;
}
