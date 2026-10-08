import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  let host;
  t.after(async () => { try { await host?.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const repository = path.join(root, 'repo');
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, 'package.json'), '{"type":"module"}\n');
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Seed']);
  const stateDir = path.join(root, 'state');
  const hostAgents = options.hostAgents ?? { ...DEFAULT_HOST_AGENTS, dsh: { ...DEFAULT_HOST_AGENTS.dsh, enabled: true } };
  host = new WebHost({ stateDir, hostAgents, nativeOptions: { executable: process.execPath, argsPrefix: [sdkFixture], profile: 'sdk' }, ...options });
  await host.init();
  return { root, repository, stateDir, host };
}

// send() acknowledges dispatch; turn/end is the actual completion boundary.
function nextTurn(session) {
  let done, fail, timer;
  const promise = new Promise((resolve, reject) => {
    done = resolve;
    fail = error => reject(new Error(error.message));
    session.once('done', done);
    session.once('error', fail);
    timer = setTimeout(() => reject(new Error('Fixture turn completion timed out')), 10000);
  });
  const turn = promise.finally(() => { clearTimeout(timer); session.off('done', done); session.off('error', fail); });
  // Cleanup remains safe when an assertion fails before awaiting completion.
  turn.catch(() => {});
  return turn;
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
  const first = nextTurn(host.nativeSession);
  await host.nativeChat('first');
  await first;
  const second = nextTurn(host.nativeSession);
  await host.nativeChat('second');
  await second;
  assert.equal(host.nativeSession.sessionId, id);
  assert.equal(host.nativeSession.history.length, 4); // user, assistant, user, assistant
  await host.close();
});

test('NativeSession reports truthful error when SDK is missing', async t => {
  const session = new NativeSession({ executable: '/nonexistent/dsh-sdk.mjs' });
  t.after(() => session.dispose());
  await assert.rejects(session.start(), /not found|not installed|ENOENT/);
});

test('NativeSession reports initialization error for unauthorized model', async t => {
  const session = new NativeSession({ executable: process.execPath, argsPrefix: [sdkFixture], env: { DSH_SDK_FAIL: 'init' }, profile: 'sdk' });
  t.after(() => session.dispose());
  await assert.rejects(session.start(), /no authorized model|initialization failed/i);
});

test('WebHost rejects mode switch while native session is streaming', async t => {
  const { host } = await hostFixture(t, { nativeOptions: { executable: process.execPath, argsPrefix: [sdkFixture], env: { DSH_SDK_SLOW: '1' }, profile: 'sdk' } });
  await host.startNativeSession();
  const sendPromise = host.nativeChat('slow');
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(host.setMode('project'), /running/i);
  const result = await sendPromise;
  assert.equal(result.state, 'streaming');
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
    agents: { codex: { enabled: true } }, commercialLoop: { enabled: false },
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
  const { post, get, host } = await serverFixture(t);
  const chat = await post('/api/native/start', { workspace: '.', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.equal(chat.status, 200);
  const completed = nextTurn(host.nativeSession);
  const send = await post('/api/native/chat', { prompt: 'hello' });
  assert.equal(send.status, 200);
  await completed;
  const state = await get('/api/state');
  assert.equal(state.data.host.native.state, 'idle');
});

test('server project setup persists config and switches to project mode', async t => {
  const { post, get, root, stateDir, repository } = await serverFixture(t);
  const projectStateDir = path.join(root, 'project-state');
  const setup = await post('/api/project/setup', {
    goal: 'Build fixture', repository, stateDir: projectStateDir, successCriteria: ['pass'],
    tests: [{ executable: 'node', args: [] }], maxActions: 3,
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.goal, 'Build fixture');
  const state = await get('/api/state');
  assert.equal(state.data.host.mode, 'project');
  assert.equal(state.data.host.projectConfigured, true);
  await assert.rejects(readFile(path.join(stateDir, 'dsh-web-project.json'), 'utf8'), /ENOENT/);
  const hostState = JSON.parse(await readFile(path.join(stateDir, 'dsh-web-host.json'), 'utf8'));
  assert.equal(hostState.projectStateDir, projectStateDir);
  const persisted = JSON.parse(await readFile(path.join(projectStateDir, 'dsh-web-project.json'), 'utf8'));
  assert.equal(persisted.goal, 'Build fixture');
  const restarted = new WebHost({ stateDir, hostAgents: { ...DEFAULT_HOST_AGENTS, dsh: { ...DEFAULT_HOST_AGENTS.dsh, enabled: true } } });
  t.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.view().projectConfig.stateDir, projectStateDir);
  assert.equal(restarted.mode, 'project');
});

test('HTTP setup rejects repository state paths before creating config, pointer or runtime', async t => {
  const { post, host, root, stateDir, repository } = await serverFixture(t);
  const nestedState = path.join(repository, 'nested-state');
  const canonicalState = path.join(root, 'canonical-state');
  await symlink(repository, canonicalState, process.platform === 'win32' ? 'junction' : 'dir');
  const config = state => ({ goal: 'fixture', repository, stateDir: state, successCriteria: ['pass'], tests: [{ executable: 'node', args: [] }] });

  for (const [label, candidate] of [['equal', repository], ['nested', nestedState], ['canonical', canonicalState]]) {
    const result = await post('/api/project/setup', config(candidate));
    assert.equal(result.status, 400, label);
    assert.match(result.data.error, /stateDir must be outside/i, label);
    await assert.rejects(readFile(path.join(candidate, 'dsh-web-project.json'), 'utf8'), { code: 'ENOENT' }, label);
    await assert.rejects(readFile(path.join(stateDir, 'dsh-web-host.json'), 'utf8'), { code: 'ENOENT' }, label);
    assert.equal(host.projectRuntime, null, label);
    assert.equal(host.projectConfig, null, label);
    assert.equal(host.mode, 'native', label);
  }
  await assert.rejects(stat(nestedState), { code: 'ENOENT' });
});

test('HTTP setup accepts distinct external project state and restarts from Host pointer', async t => {
  const { post, root, stateDir, repository } = await serverFixture(t);
  const projectStateDir = path.join(root, 'valid-external-state');
  const setup = await post('/api/project/setup', {
    goal: 'External state fixture', repository, stateDir: projectStateDir, successCriteria: ['pass'], tests: [{ executable: 'node', args: [] }],
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  await assert.rejects(readFile(path.join(stateDir, 'dsh-web-project.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'dsh-web-host.json'), 'utf8')).projectStateDir, projectStateDir);
  assert.equal(JSON.parse(await readFile(path.join(projectStateDir, 'dsh-web-project.json'), 'utf8')).stateDir, projectStateDir);

  const restarted = new WebHost({ stateDir, hostAgents: { ...DEFAULT_HOST_AGENTS, dsh: { ...DEFAULT_HOST_AGENTS.dsh, enabled: true } } });
  t.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.mode, 'project');
  assert.equal(restarted.view().projectConfig.stateDir, projectStateDir);
  assert.ok(restarted.projectRuntime);
});

test('server rejects native chat in project mode and project setup in native mode', async t => {
  const { post, root, stateDir, repository, host } = await serverFixture(t);
  await host.startNativeSession();
  const completed = nextTurn(host.nativeSession);
  const nativeChat = await post('/api/native/chat', { prompt: 'hello' });
  assert.equal(nativeChat.status, 200);
  await completed;
  const setup = await post('/api/project/setup', { goal: 'x', repository, stateDir, successCriteria: ['s'], tests: [{ executable: 'node', args: [] }] });
  assert.equal(setup.status, 200);
  const badNative = await post('/api/native/chat', { prompt: 'hello' });
  assert.equal(badNative.status, 400);
  assert.match(badNative.data.error, /Not in native/);
});

test('mergeAgentConfigs preserves trusted Host provider settings internally', () => {
  const host = { opencode: { transport: 'opencode', openCodeProvider: { apiKeyEnv: 'KEY' }, enabled: true } };
  const project = { opencode: { enabled: true } };
  const merged = mergeAgentConfigs(project, host);
  assert.deepEqual(merged.opencode.openCodeProvider, host.opencode.openCodeProvider);
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
    maxActions: 1, agents: { codex: { enabled: true }, dsh: { enabled: true } }, commercialLoop: { enabled: false },
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
  t.after(() => session.dispose());
  const messages = [];
  session.on('message', msg => messages.push(msg));
  await session.start();
  const completed = nextTurn(session);
  await session.send('hello world');
  await completed;
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

test('NativeSession fails promptly when the SDK reports a turn error', async t => {
  const session = new NativeSession({ executable: process.execPath, argsPrefix: [sdkFixture], env: { DSH_SDK_FAIL: 'turn' }, profile: 'sdk', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  t.after(() => session.dispose());
  const errors = [];
  session.on('error', error => errors.push(error));
  await session.start();
  const failed = assert.rejects(nextTurn(session), /DSH turn ended error/i);
  await session.send('hello');
  await failed;
  assert.ok(errors.length > 0);
  assert.match(errors[0].message, /DSH turn ended error/i);
  await session.dispose();
});

test('WebHost refuses native start when no provider/model is enabled', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-unconfigured-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new WebHost({ stateDir: path.join(root, 'state'), hostAgents: DEFAULT_HOST_AGENTS, nativeOptions: {} });
  await host.init();
  t.after(() => host.close());
  await assert.rejects(host.startNativeSession(), /not configured|no enabled Host provider/i);
  assert.equal(host.view().nativeConfigured, false);
});

test('HTTP native/start ignores browser executable override and uses Host allowlist', async t => {
  const { post, get } = await serverFixture(t);
  const start = await post('/api/native/start', { workspace: '.', provider: 'deepseek-official', model: 'deepseek-v4-flash', executable: '/nonexistent/override.mjs' });
  assert.equal(start.status, 200);
  const state = await get('/api/state');
  assert.equal(state.data.host.native.state, 'idle');
});

test('HTTP native/start cannot activate explicitly disabled native mode', async t => {
  const { post, host } = await serverFixture(t, { nativeOptions: { enabled: false, executable: process.execPath, argsPrefix: [sdkFixture] } });
  const result = await post('/api/native/start', {});
  assert.equal(result.status, 400);
  assert.match(result.data.error, /no enabled Host provider\/model allowlist/);
  assert.equal(host.nativeSession, null);
  assert.equal(host.view().nativeConfigured, false);
});

test('HTTP native/start requires a real enabled DSH binding, not another transport', async t => {
  const { post, host } = await serverFixture(t, { hostAgents: {
    dsh: { transport: 'dsh', enabled: false, provider: 'fixture', model: 'fixture-model' },
    other: { transport: 'opencode', enabled: true, provider: 'fixture', model: 'fixture-model' },
  } });
  const result = await post('/api/native/start', { provider: 'fixture', model: 'fixture-model' });
  assert.equal(result.status, 400);
  assert.equal(host.nativeSession, null);
  assert.deepEqual(host.view().nativeChoices, []);
});

test('mergeAgentConfigs prevents browser activation and preserves all trusted launcher fields', () => {
  const host = {
    active: { enabled: true, transport: 'opencode', executable: 'trusted', argsPrefix: ['trusted-entry'], env: { FIXTURE: 'trusted' }, openCodeProvider: { apiKeyEnv: 'HOST_KEY' }, paidApi: { endpoint: 'https://example.com' } },
    disabled: { enabled: false, transport: 'dsh' },
  };
  const result = mergeAgentConfigs({ active: { enabled: true, executable: 'browser', argsPrefix: ['browser-entry'], env: { FIXTURE: 'browser' }, paidApi: false }, disabled: { enabled: true }, unknown: { enabled: true } }, host);
  assert.deepEqual(Object.keys(result), ['active']);
  assert.deepEqual(result.active, host.active);
  result.active.env.FIXTURE = 'changed';
  assert.equal(host.active.env.FIXTURE, 'trusted');
  assert.deepEqual(mergeAgentConfigs({ active: { enabled: false } }, host), {});
});

test('HTTP setup rejects Host-owned launcher and routing overrides', async t => {
  const { post, stateDir, repository } = await serverFixture(t);
  const config = { goal: 'fixture', repository, stateDir, successCriteria: ['pass'], tests: [{ executable: 'node', args: [] }] };
  for (const field of ['executable', 'env', 'argsPrefix', 'provider', 'paidApi']) {
    const result = await post('/api/project/setup', { ...config, agents: { opencodeGo: { enabled: true, [field]: 'browser' } } });
    assert.equal(result.status, 400, field);
    assert.match(result.data.error, /Host-owned/);
  }
  const result = await post('/api/project/setup', { ...config, models: [] });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /models are Host-owned/);
});

test('HTTP setup rejects browser routing policy overrides without replacing saved runtime', async t => {
  const { post, host, root, repository } = await serverFixture(t, { hostAgents: {
    opencodeGo: { ...DEFAULT_HOST_AGENTS.opencodeGo, enabled: true, executable: process.execPath, argsPrefix: [agentCli], env: { DSH_PROTOCOL_FIXTURE: 'opencode' } },
    paidCommercial: { transport: 'opencode', connectionId: 'paid-account', enabled: true, executable: process.execPath, argsPrefix: [agentCli], env: { DSH_PROTOCOL_FIXTURE: 'opencode' }, paidApi: { endpoint: 'https://api.example.invalid' } },
  } });
  const stateDir = path.join(root, 'project-state');
  const config = { goal: 'fixture', repository, stateDir, successCriteria: ['pass'], tests: [{ executable: 'node', args: [] }] };
  const valid = await post('/api/project/setup', config);
  assert.equal(valid.status, 200);
  const savedFile = path.join(stateDir, 'dsh-web-project.json');
  const savedBefore = await readFile(savedFile, 'utf8');
  const runtimeBefore = host.projectRuntime;
  const runtimeConfigBefore = JSON.stringify(host.projectRuntime.config);

  for (const [label, override, expected] of [
    ['autoModelRouting', { autoModelRouting: false }, /autoModelRouting is Host-owned/],
    ['decisionAgent', { decisionAgent: 'paidCommercial' }, /decisionAgent is Host-owned/],
    ['commercial worker', { commercialLoop: { enabled: true, worker: 'paidCommercial' } }, /commercialLoop\.worker is Host-owned/],
  ]) {
    const result = await post('/api/project/setup', { ...config, ...override });
    assert.equal(result.status, 400, label);
    assert.match(result.data.error, expected, label);
    assert.equal(await readFile(savedFile, 'utf8'), savedBefore, label);
    assert.equal(host.projectRuntime, runtimeBefore, label);
    assert.equal(JSON.stringify(host.projectRuntime.config), runtimeConfigBefore, label);
  }
});

test('NativeSession promptly reports prompt JSON-RPC errors and confirms cleanup', async t => {
  const session = new NativeSession({ executable: process.execPath, argsPrefix: [sdkFixture], env: { DSH_SDK_FAIL: 'prompt' } });
  t.after(() => session.dispose());
  await session.start();
  const failed = assert.rejects(nextTurn(session), /Prompt rejected: selected model is not authorized/);
  await session.send('fixture');
  await failed;
  await session.dispose();
  assert.equal(session.state, 'error');
  assert.equal(session.child, null);
  assert.equal(session.history.filter(item => item.role === 'assistant').length, 0);
});

test('Web setup defaults to commercial loop with an enabled Host worker alias', async t => {
  const { host, repository, stateDir } = await hostFixture(t, { hostAgents: {
    authorized: { transport: 'opencode', enabled: true, executable: process.execPath, argsPrefix: [agentCli], env: { DSH_PROTOCOL_FIXTURE: 'opencode' } },
  } });
  await host.setupProject({ goal: 'fixture', repository, stateDir, successCriteria: ['pass'], tests: [{ executable: 'node', args: [] }] });
  assert.equal(host.projectConfig.commercialLoop.enabled, true);
  assert.equal(host.projectRuntime.config.commercialLoop.worker, 'authorized');
  assert.equal(host.view().projectWorld.world.goal, 'fixture');
});

test('HTTP setup rejects browser account and funding overrides before project creation', async t => {
  const { post, host, repository, stateDir } = await serverFixture(t);
  const trusted = structuredClone(host.hostAgents);
  const config = { goal: 'fixture', repository, stateDir, successCriteria: ['pass'], tests: [{ executable: 'node', args: [] }] };
  for (const field of ['connectionId', 'accountId', 'quotaGroup', 'funding', 'apiKeyEnv', 'openCodeProvider']) {
    const result = await post('/api/project/setup', { ...config, agents: { opencodeGo: { enabled: true, [field]: 'browser-override' } } });
    assert.equal(result.status, 400, field);
    assert.match(result.data.error, /Host-owned/, field);
    assert.equal(host.projectRuntime, null, field);
    assert.equal(host.projectConfig, null, field);
    assert.deepEqual(host.hostAgents, trusted, field);
    await assert.rejects(readFile(path.join(stateDir, 'dsh-web-project.json')), { code: 'ENOENT' });
  }
  const valid = await post('/api/project/setup', config);
  assert.equal(valid.status, 200);
  assert.equal(host.projectConfig.commercialLoop.enabled, true);
  assert.deepEqual(host.hostAgents, trusted);
});

test('HTTP native/start keeps the SDK workspace Host-owned', async t => {
  const { post, host, root } = await serverFixture(t);
  const workspace = path.join(root, 'trusted-native');
  await mkdir(workspace);
  host.nativeOptions.workspace = workspace;
  const result = await post('/api/native/start', { workspace: path.join(root, 'browser-native'), env: { BROWSER_OVERRIDE: '1' } });
  assert.equal(result.status, 200);
  assert.equal(host.nativeSession.workspace, workspace);
  assert.equal(host.view().nativeWorkspace, workspace);
  assert.equal(host.projectRuntime, null);
  const completed = nextTurn(host.nativeSession);
  await host.nativeChat('Host workspace fixture');
  await completed;
  assert.equal(host.nativeSession.state, 'idle');
});

test('HTTP setup denies browser execution policy changes before persistence', async t => {
  const { post, host, repository, stateDir } = await serverFixture(t);
  const config = { goal: 'fixture', repository, stateDir, successCriteria: ['pass'], tests: [{ executable: 'node', args: [] }] };
  for (const permissions of [{ shell: true }, { network: true }, { gitCommit: true }, { write: false }, { read: false }, { customTool: true }, null, []]) {
    const result = await post('/api/project/setup', { ...config, permissions });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /permissions are Host-owned/);
    assert.equal(host.projectRuntime, null);
    assert.equal(host.projectConfig, null);
    await assert.rejects(readFile(path.join(stateDir, 'dsh-web-project.json')), { code: 'ENOENT' });
  }
  const valid = await post('/api/project/setup', config);
  assert.equal(valid.status, 200);
  const expected = { read: true, write: true, shell: false, network: false, gitCommit: false };
  assert.deepEqual(host.projectRuntime.config.permissions, expected);
  assert.deepEqual((await loadProjectConfig(stateDir)).permissions, expected);
});
