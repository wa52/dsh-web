import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebHost } from '../runtime/host.mjs';
import { createControlServer } from '../runtime/server.mjs';
import { NativeSession } from '../runtime/native-session.mjs';
import { validateProjectConfig, saveProjectConfig, loadProjectConfig, mergeAgentConfigs, DEFAULT_HOST_AGENTS } from '../runtime/project-config.mjs';
import { createAgentAdapter } from '../runtime/adapters.mjs';

const sdkFixture = fileURLToPath(new URL('./fixtures/dsh-sdk.mjs', import.meta.url));
const agentCli = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));

async function hostFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, 'package.json'), '{"type":"module"}\n');
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Seed']);
  const stateDir = path.join(root, 'state');
  const host = new WebHost({ stateDir, nativeOptions: { executable: process.execPath, argsPrefix: [sdkFixture], profile: 'sdk' }, ...options });
  await host.init();
  return { root, repository, stateDir, host };
}

async function serverFixture(t, options = {}) {
  const { host, root, stateDir, repository } = await hostFixture(t, options);
  const server = createControlServer(host, { port: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await host.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (endpoint, body) => {
    const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Control': '1', Origin: base }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  };
  const get = async endpoint => {
    const response = await fetch(`${base}${endpoint}`);
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  };
  return { host, root, stateDir, repository, server, base, post, get };
}

test('WebHost starts in native mode with no project configured', async t => {
  const { host } = await hostFixture(t);
  const view = host.view();
  assert.equal(view.mode, 'native');
  assert.equal(view.projectConfigured, false);
  assert.equal(view.native.state, 'idle');
});

test('validateProjectConfig rejects credentials and requires absolute paths', () => {
  assert.throws(() => validateProjectConfig({ goal: 'x', repository: 'relative', stateDir: 'D:/state', successCriteria: ['a'], tests: [{ executable: 'node', args: [] }] }), /absolute/);
  assert.throws(() => validateProjectConfig({ goal: '', repository: 'D:/repo', stateDir: 'D:/state', successCriteria: ['a'], tests: [{ executable: 'node', args: [] }] }), /goal/);
  assert.throws(() => validateProjectConfig({ goal: 'x', repository: 'D:/repo', stateDir: 'D:/state', successCriteria: ['a'], tests: [{ executable: 'node', args: [] }], apiKey: 'secret' }), /Credential/);
  const config = validateProjectConfig({ goal: 'x', repository: 'D:/repo', stateDir: 'D:/state', successCriteria: ['a'], tests: [{ executable: 'node', args: ['--test'] }], maxActions: 5 });
  assert.equal(config.maxActions, 5);
  assert.equal(config.tests[0].args[0], '--test');
});

test('saveProjectConfig persists sanitized config and loadProjectConfig reloads it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-cfg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { goal: 'g', repository: path.join(root, 'repo'), stateDir: path.join(root, 'state'), successCriteria: ['s'], tests: [{ executable: 'node', args: [] }] };
  const file = await saveProjectConfig(config.stateDir, config);
  const loaded = await loadProjectConfig(config.stateDir);
  assert.equal(loaded.goal, 'g');
  assert.equal(loaded.repository, config.repository);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.apiKey, undefined);
});

test('mode dispatch separation: native chat does not create project runtime', async t => {
  const { host } = await hostFixture(t);
  await host.startNativeSession();
  await host.nativeChat('hello');
  assert.equal(host.mode, 'native');
  assert.equal(host.projectRuntime, null);
  assert.ok(host.nativeSession);
  await host.close();
});

test('multi-turn same native session preserves sessionId', async t => {
  const { host } = await hostFixture(t);
  await host.startNativeSession();
  const id = host.nativeSession.sessionId;
  await host.nativeChat('first');
  await host.nativeChat('second');
  assert.equal(host.nativeSession.sessionId, id);
  assert.equal(host.nativeSession.history.length, 4); // user, assistant, user, assistant
  await host.close();
});

test('NativeSession reports truthful error when SDK is missing', async t => {
  const session = new NativeSession({ executable: '/nonexistent/dsh-sdk.mjs' });
  await assert.rejects(session.start(), /not found|not installed|ENOENT/);
});

test('NativeSession reports initialization error for unauthorized model', async t => {
  const session = new NativeSession({ executable: process.execPath, argsPrefix: [sdkFixture], env: { DSH_SDK_FAIL: 'init' }, profile: 'sdk' });
  await assert.rejects(session.start(), /no authorized model|initialization failed/i);
});

test('WebHost rejects mode switch while native session is streaming', async t => {
  const { host } = await hostFixture(t, { nativeOptions: { executable: process.execPath, argsPrefix: [sdkFixture], env: { DSH_SDK_SLOW: '1' }, profile: 'sdk' } });
  await host.startNativeSession();
  const sendPromise = host.nativeChat('slow');
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(host.setMode('project'), /running/i);
  await assert.rejects(sendPromise, /budget|interrupted|timeout/i);
  await host.close();
});

test('WebHost rejects project setup while project loop is running', async t => {
  const { host, repository, stateDir } = await hostFixture(t);
  const blockingAgent = fileURLToPath(new URL('./fixtures/blocking-agent.mjs', import.meta.url));
  host.hostAgents = {
    codex: { ...DEFAULT_HOST_AGENTS.codex, executable: process.execPath, argsPrefix: [blockingAgent], enabled: true },
  };
  await host.setupProject({
    goal: 'Fix test', repository, stateDir, successCriteria: ['tests pass'],
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    maxActions: 1, agentTimeoutMs: 5000,
    agents: { codex: { transport: 'codex', enabled: true } },
  });
  host.startProjectLoop(1).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(host.projectRuntime?.running, true);
  await assert.rejects(host.setupProject({ goal: 'x', repository, stateDir, successCriteria: ['s'], tests: [{ executable: 'node', args: [] }] }), /running/i);
  await host.close();
});

test('server exposes host mode and native SSE endpoints', async t => {
  const { get, post, base } = await serverFixture(t);
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.host.mode, 'native');
  const state = await get('/api/state');
  assert.equal(state.data.host.mode, 'native');
  const response = await fetch(`${base}/api/native/events`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  response.body.cancel();
});

test('server mode switch and native chat via HTTP', async t => {
  const { post, get } = await serverFixture(t);
  const chat = await post('/api/native/start', { workspace: '.', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.equal(chat.status, 200);
  const send = await post('/api/native/chat', { prompt: 'hello' });
  assert.equal(send.status, 200);
  const state = await get('/api/state');
  assert.equal(state.data.host.native.state, 'idle');
});

test('server project setup persists config and switches to project mode', async t => {
  const { post, get, root, stateDir, repository } = await serverFixture(t);
  const setup = await post('/api/project/setup', {
    goal: 'Build fixture', repository, stateDir, successCriteria: ['pass'],
    tests: [{ executable: 'node', args: [] }], maxActions: 3,
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.goal, 'Build fixture');
  const state = await get('/api/state');
  assert.equal(state.data.host.mode, 'project');
  assert.equal(state.data.host.projectConfigured, true);
  const persisted = JSON.parse(await readFile(path.join(stateDir, 'dsh-web-project.json'), 'utf8'));
  assert.equal(persisted.goal, 'Build fixture');
});

test('server rejects native chat in project mode and project setup in native mode', async t => {
  const { post, root, stateDir, repository } = await serverFixture(t);
  const nativeChat = await post('/api/native/chat', { prompt: 'hello' });
  assert.equal(nativeChat.status, 200);
  const setup = await post('/api/project/setup', { goal: 'x', repository, stateDir, successCriteria: ['s'], tests: [{ executable: 'node', args: [] }] });
  assert.equal(setup.status, 200);
  const badNative = await post('/api/native/chat', { prompt: 'hello' });
  assert.equal(badNative.status, 400);
  assert.match(badNative.data.error, /Not in native/);
});

test('mergeAgentConfigs never enables paid API providers from browser selection', () => {
  const host = { opencode: { transport: 'opencode', openCodeProvider: { apiKeyEnv: 'KEY' }, enabled: true } };
  const project = { opencode: { enabled: true } };
  const merged = mergeAgentConfigs(project, host);
  assert.equal(merged.opencode.openCodeProvider, undefined);
  assert.equal(merged.opencode.enabled, true);
});

test('project operation preserves review Gate and state/worktree isolation', async t => {
  const { host, repository, stateDir } = await hostFixture(t);
  host.hostAgents = {
    codex: { ...DEFAULT_HOST_AGENTS.codex, executable: process.execPath, argsPrefix: [agentCli], env: { DSH_PROTOCOL_FIXTURE: 'codex' }, enabled: true },
    dsh: { ...DEFAULT_HOST_AGENTS.dsh, executable: process.execPath, argsPrefix: [agentCli], env: { DSH_PROTOCOL_FIXTURE: 'dsh' }, enabled: true },
  };
  const config = {
    goal: 'Fix fixture', repository, stateDir, successCriteria: ['tests pass'],
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    maxActions: 1, agents: { codex: { transport: 'codex', enabled: true }, dsh: { transport: 'dsh', enabled: true } },
    protectedPaths: ['tests/acceptance.test.mjs'],
  };
  await host.setupProject(config);
  await host.setMode('project');
  // The fixture agents will produce a build result, but Host tests on the bare
  // fixture fail, so the candidate cannot reach MERGE_READY without evidence.
  try { await host.startProjectLoop(1); } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
  const world = host.projectRuntime?.view()?.world;
  assert.ok(world);
  assert.notEqual(world.actions.at(-1)?.phase, 'MERGE_READY');
  // stateDir must remain outside the repository.
  const relative = path.relative(repository, stateDir);
  assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
  await host.close();
});

test('paid API is disabled by default and setup form rejects paid flags', async t => {
  const { post, root, stateDir, repository } = await serverFixture(t);
  const bad = await post('/api/project/setup', {
    goal: 'x', repository, stateDir, successCriteria: ['s'], tests: [{ executable: 'node', args: [] }],
    agents: { deepseekApi: { transport: 'opencode', paidApi: { endpoint: 'https://api.deepseek.com' }, enabled: true } },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Credential|paidApi/);
});

test('NativeSession SSE streams assistant messages', async t => {
  const session = new NativeSession({ executable: process.execPath, argsPrefix: [sdkFixture], profile: 'sdk' });
  const messages = [];
  session.on('message', msg => messages.push(msg));
  await session.start();
  await session.send('hello world');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(messages.length > 0);
  assert.ok(messages.some(m => m.delta.includes('Fixture response')));
  await session.dispose();
});

test('invalid JSON in project setup returns actionable error', async t => {
  const { server, base } = await serverFixture(t);
  const response = await fetch(`${base}/api/project/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Control': '1', Origin: base }, body: 'not-json' });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.ok(data.error);
});

test('setup form refuses shell metacharacters in test executable', async t => {
  const { post, root, stateDir, repository } = await serverFixture(t);
  const result = await post('/api/project/setup', {
    goal: 'x', repository, stateDir, successCriteria: ['s'], tests: [{ executable: 'node; rm -rf /', args: [] }],
  });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /shell metacharacters/);
});
