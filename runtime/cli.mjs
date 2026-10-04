import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import * as control from '../plugins/autonomous-control-loop/index.js';
import { createAgentAdapter } from './adapters.mjs';
import { createControlServer } from './server.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('DSH Autonomous Runtime\nnode runtime/cli.mjs [--config project.json] [--port 4780] [--run]\nWithout config: observer UI only. --run executes a bounded project loop without HTTP.');
} else {
  const ctx = new Context();
  const fiber = ctx.plugin(control);
  await new Promise(resolve => setImmediate(resolve));
  let runtime;
  const configFile = option('--config');
  if (configFile) {
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    const agents = Object.entries(config.agents ?? {}).map(([provider, options]) => createAgentAdapter(provider, options));
    runtime = ctx.autonomousControl.createProject(config, { agents });
    await runtime.initialize();
  }
  if (args.includes('--run')) {
    if (!runtime) throw new Error('--run requires --config');
    try { const state = await runtime.start(); console.log(JSON.stringify({ status: state.status, acceptedHead: state.acceptedHead, stateFile: runtime.store.file }, null, 2)); }
    finally { await fiber.dispose(); }
  } else {
    const port = Number(option('--port', '4780'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createControlServer(runtime, { port });
    server.listen(port, '127.0.0.1', () => console.log(`DSH control: http://127.0.0.1:${port}${runtime ? '' : ' (no project configured)'}`));
    let closing = false;
    const stop = async () => {
      if (closing) return; closing = true;
      await fiber.dispose();
      server.close(); server.closeAllConnections();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }
}
