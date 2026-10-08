import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebHost } from '../runtime/host.mjs';
import { DEFAULT_HOST_AGENTS } from '../runtime/project-config.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cliFile = fileURLToPath(new URL('../runtime/cli.mjs', import.meta.url));
const sdkFixture = fileURLToPath(new URL('./fixtures/dsh-sdk-settings.mjs', import.meta.url));
const agentFixture = fileURLToPath(new URL('./fixtures/host-agent-model.mjs', import.meta.url));

const models = [
  { id: 'host-routine', provider: 'opencode', connectionId: 'opencode-account', tier: 'routine', cost: 1 },
  { id: 'host-deep', provider: 'opencode', connectionId: 'opencode-account', tier: 'deep', cost: 3 },
  { id: 'host-security', provider: 'opencode', connectionId: 'opencode-account', tier: 'security', cost: 4 },
  { id: 'host-paid-deep', provider: 'opencode', connectionId: 'paid-account', tier: 'deep', cost: 0.01, paid: true, endpoint: 'https://api.example.invalid' },
  { id: 'disabled-routine', provider: 'opencode', connectionId: 'disabled-account', tier: 'routine', cost: 0.001 },
];

function hostAgents() {
  return {
    opencodeGo: {
      transport: 'opencode', connectionId: 'opencode-account', executable: process.execPath,
      argsPrefix: [agentFixture], enabled: true, roles: ['decide', 'build', 'review'],
      capabilities: ['reason', 'code', 'review', 'security'],
    },
    paidOpenCode: {
      transport: 'opencode', connectionId: 'paid-account', executable: process.execPath,
      argsPrefix: [agentFixture], enabled: true, roles: ['decide', 'build', 'review'],
      capabilities: ['reason', 'code', 'review', 'security'],
      paidApi: { endpoint: 'https://api.example.invalid' },
      openCodeProvider: { id: 'host-paid-provider', name: 'Host paid fixture', baseURL: 'https://api.example.invalid' },
    },
    disabled: { transport: 'opencode', connectionId: 'disabled-account', enabled: false },
  };
}

async function repositoryAt(root) {
  const repository = path.join(root, 'repo');
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, 'package.json'), '{"type":"module"}\n');
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Seed']);
  return repository;
}

function projectSetup(repository, stateDir) {
  return {
    goal: 'Exercise trusted model routing with local fixtures', repository, stateDir,
    successCriteria: ['Host routing remains intact'],
    tests: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
    agents: { opencodeGo: { enabled: true } },
    commercialLoop: { enabled: false },
  };
}

function assertRouted(projectRuntime) {
  const agent = projectRuntime.registry.agents.get('opencodeGo');
  assert.ok(agent, 'funded Host connection is registered');
  assert.equal(projectRuntime.registry.agents.has('paidOpenCode'), false, 'omitted Host connection is excluded by explicit project selection');
  assert.equal(projectRuntime.registry.agents.has('disabled'), false, 'disabled Host connection is not registered');
  assert.equal(projectRuntime.routeFor(agent, { role: 'build', risk: 'normal' }).selectedModel, 'host-routine');
  assert.equal(projectRuntime.routeFor(agent, { role: 'build', risk: 'high' }).selectedModel, 'host-deep');
  assert.equal(projectRuntime.routeFor(agent, { role: 'review', capabilities: ['security'] }).selectedModel, 'host-security');
  assert.ok(!projectRuntime.config.models.some(model => model.id === 'disabled-routine'), 'disabled Host connection models are removed from effective project config');
  assert.ok(!projectRuntime.config.models.some(model => model.id === 'host-paid-deep'), 'omitted connection models are excluded from the effective catalog');
  assert.equal(projectRuntime.routeFor(agent, { role: 'build', risk: 'high' }).selectedModel, 'host-deep', 'paid model cannot displace an eligible free model without a project grant');
}

test('Web setup and restart apply explicit Host connection selection to runtime and model routing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-host-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await repositoryAt(root);
  const hostStateDir = path.join(root, 'host-state');
  const projectStateDir = path.join(root, 'project-state');
  const trustedAgents = hostAgents();
  const host = new WebHost({ stateDir: hostStateDir, hostAgents: trustedAgents, hostModels: models });
  await host.init();
  await host.setupProject(projectSetup(repository, projectStateDir));

  assertRouted(host.projectRuntime);
  assert.equal(host.view().projectConfig.models, undefined);
  await assert.rejects(readFile(path.join(hostStateDir, 'dsh-web-project.json'), 'utf8'), /ENOENT/);
  const saved = JSON.parse(await readFile(path.join(projectStateDir, 'dsh-web-project.json'), 'utf8'));
  assert.equal(saved.models, undefined);
  assert.equal(JSON.stringify(saved).includes('host-routine'), false);
  await host.close();

  const restarted = new WebHost({ stateDir: hostStateDir, hostAgents: trustedAgents, hostModels: models });
  t.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.mode, 'project');
  assertRouted(restarted.projectRuntime);
});

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(child, base) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CLI exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`CLI did not become ready: ${lastError?.message ?? 'startup timeout'}`);
}

test('CLI startup applies trusted nativeOptions and Host models through local SDK and Agent fixtures', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-cli-host-settings-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await rm(root, { recursive: true, force: true });
  });
  const repository = await repositoryAt(root);
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'trusted-native-workspace');
  await mkdir(workspace);
  const nativeSettingsFile = path.join(root, 'native-settings.json');
  const agentArgsFile = path.join(root, 'agent-args.json');
  const port = await unusedPort();
  const hostConfigFile = path.join(root, 'host.json');
  const settings = {
    agents: {
      ...hostAgents(),
      dsh: { ...DEFAULT_HOST_AGENTS.dsh, enabled: true, provider: 'fixture-provider', model: 'fixture-native-model' },
      opencodeGo: {
        ...hostAgents().opencodeGo,
        env: { DSH_AGENT_ARGS_FILE: agentArgsFile },
      },
    },
    models,
    nativeOptions: {
      executable: process.execPath, argsPrefix: [sdkFixture], profile: 'fixture-profile',
      workspace, artifactDir: path.join(root, 'native-artifacts'), env: { DSH_NATIVE_SETTINGS_FILE: nativeSettingsFile },
    },
  };
  await writeFile(hostConfigFile, JSON.stringify(settings));
  child = spawn(process.execPath, [cliFile, '--host-agents', hostConfigFile, '--state-dir', stateDir, '--port', String(port)], {
    cwd: rootDir,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(child, base).catch(error => { throw new Error(`${error.message}; ${stderr}`); });

  const post = async (endpoint, body) => {
    const response = await fetch(`${base}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Control': '1', Origin: base },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  const native = await post('/api/native/start', { provider: 'fixture-provider', model: 'fixture-native-model', workspace: path.join(root, 'browser-workspace'), executable: 'browser-owned' });
  assert.equal(native.status, 200, JSON.stringify(native.data));
  const nativeSettings = JSON.parse(await readFile(nativeSettingsFile, 'utf8'));
  assert.deepEqual(nativeSettings.params, { cwd: workspace, provider: 'fixture-provider', model: 'fixture-native-model' });
  assert.deepEqual(nativeSettings.args, ['--profile', 'fixture-profile']);
  assert.equal(nativeSettings.cwd, workspace);
  await post('/api/native/stop', {});

  const setup = await post('/api/project/setup', projectSetup(repository, stateDir));
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.equal(setup.data.models, undefined);
  const persisted = JSON.parse(await readFile(path.join(stateDir, 'dsh-web-project.json'), 'utf8'));
  assert.equal(persisted.models, undefined);

  const started = await post('/api/start', { maxActions: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const deadline = Date.now() + 30_000;
  let selected;
  let args;
  let paidRuns;
  let terminal;
  let lastState;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/state`);
    const data = await response.json();
    lastState = data.host?.projectWorld?.world;
    selected = data.host?.projectWorld?.world?.runs?.find(run => run.routing)?.routing?.selectedModel;
    paidRuns = data.host?.projectWorld?.agents?.find(agent => agent.id === 'paidOpenCode')?.runs?.length;
    try { args = JSON.parse(await readFile(agentArgsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (selected && args) break;
    terminal = data.host?.projectWorld?.running === false && ['complete', 'budget-exhausted', 'failed', 'paused', 'idle', 'stopped', 'blocked'].includes(data.host?.projectWorld?.world?.status);
    if (terminal && selected && !args) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(selected, 'host-routine', 'CLI-loaded Host model registry routes the first project decision');
  assert.ok(args, `local Agent fixture was launched; terminal=${terminal}; status=${lastState?.status}; failures=${JSON.stringify(lastState?.failures?.slice(-2) ?? [])}`);
  assert.equal(args[args.indexOf('--model') + 1], 'host-routine');
  assert.equal(paidRuns, undefined, 'explicit project selection excludes the omitted paid worker');
  await post('/api/cancel', {});
  assert.equal(stderr.includes('API key'), false);
});
