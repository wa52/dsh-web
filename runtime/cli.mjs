import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as control from '../plugins/autonomous-control-loop/index.js';
import { createAgentAdapter } from './adapters.mjs';
import { createControlServer } from './server.mjs';
import { WebHost } from './host.mjs';
import { DEFAULT_HOST_AGENTS } from './project-config.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };

async function loadHostAgents() {
  const file = option('--host-agents') ?? (existsSync('config.host.json') ? 'config.host.json' : null);
  if (!file) return DEFAULT_HOST_AGENTS;
  const raw = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  return raw.agents ?? DEFAULT_HOST_AGENTS;
}

async function createProjectRuntimeFromConfig(ctx, config) {
  const agents = Object.entries(config.agents ?? {}).map(([alias, options]) => {
    const settings = { ...options, id: options.id ?? alias, connectionId: options.connectionId ?? alias };
    if (settings.enabled !== false && settings.openCodeProvider?.apiKeyEnv && !process.env[settings.openCodeProvider.apiKeyEnv]) {
      throw new Error(`Connection ${alias} requires environment variable ${settings.openCodeProvider.apiKeyEnv}; configure it before startup`);
    }
    return createAgentAdapter(settings.transport ?? alias, settings);
  });
  const runtime = ctx.autonomousControl.createProject(config, { agents });
  await runtime.initialize();
  return runtime;
}

if (args.includes('--help')) {
  console.log('DSH Autonomous Runtime\nnode runtime/cli.mjs [--config project.json] [--host-agents agents.json] [--port 4780] [--run]\nWithout config: Web host mode with native conversation and project setup UI. --run executes a bounded project loop without HTTP.');
} else {
  const configFile = option('--config');
  let runtime;
  let host;
  let ctx;
  let fiber;
  if (configFile) {
    ctx = new Context();
    fiber = ctx.plugin(control);
    await new Promise(resolve => setImmediate(resolve));
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    runtime = await createProjectRuntimeFromConfig(ctx, config);
  } else {
    // Web host mode: load agents from host config, allow UI-driven project setup.
    const hostAgents = await loadHostAgents();
    const stateDir = option('--state-dir') ?? path.resolve('.tmp', 'dsh-web-host');
    host = new WebHost({ hostAgents, stateDir, nativeOptions: {} });
    await host.init();
    runtime = host.projectRuntime;
  }
  if (args.includes('--run')) {
    if (!runtime) throw new Error('--run requires a configured project');
    try { const state = await runtime.start(); console.log(JSON.stringify({ status: state.status, acceptedHead: state.acceptedHead, stateFile: runtime.store.file }, null, 2)); }
    finally { if (fiber) await fiber.dispose(); if (host) await host.close(); }
  } else {
    const port = Number(option('--port', '4780'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createControlServer(host ?? runtime, { port });
    server.listen(port, '127.0.0.1', () => console.log(`DSH control: http://127.0.0.1:${port}${host ? ' (Web host mode: choose native chat or project setup)' : (runtime ? '' : ' (no project configured)')}`));
    let closing = false;
    const stop = async () => {
      if (closing) return; closing = true;
      if (host) await host.close();
      if (fiber) await fiber.dispose();
      server.close(); server.closeAllConnections();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }
}
