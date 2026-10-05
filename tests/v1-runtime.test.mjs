import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ProjectRuntime } from '../runtime/project.mjs';
import { ProcessAdapter, parseObject, processFingerprint } from '../runtime/process.mjs';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { AgentRegistry } from '../runtime/registry.mjs';
import { guardPath, denyTool } from '../runtime/permissions.mjs';
import { createControlServer } from '../runtime/server.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';
import { fileURLToPath } from 'node:url';
import { recoverInterruptedProject } from '../runtime/recovery.mjs';
import { WorldStore } from '../runtime/store.mjs';
import { randomUUID } from 'node:crypto';
import { changedPathRisk, sourceObservation } from '../runtime/governance.mjs';
import { validateAssessment, ModelDecision } from '../runtime/decision.mjs';

test('provider envelopes accept one JSON block and reject ambiguous reports', () => {
  assert.deepEqual(parseObject('Review evidence\n```json\n{"verdict":"reject"}\n```'), { verdict: 'reject' });
  assert.throws(() => parseObject('```json\n{}\n```\n```json\n{}\n```'), /Ambiguous/);
  assert.throws(() => parseObject('All tests passed'), /JSON/);
});

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createCheckoutFixture(path.join(root, 'repo'));
  const config = { ...fixture, stateDir: path.join(root, 'state'), constraints: ['Never change tests'], protectedPaths: ['tests/acceptance.test.mjs'], permissions: { shell: false, network: false }, tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }] };
  return { root, config };
}

function controlledAdapter(id, build, review) {
  // Deterministic test double; never represented as a live model acceptance.
  return { id, provider: 'test-double', roles: ['build', 'review'], capabilities: ['code', 'ui', 'review', 'security', 'reason'], trust: id === 'code-worker' ? 0.95 : 0.75, cost: 1, availability: 'online',
    describe() { return { id, roles: this.roles, availability: this.availability, runs: [] }; },
    async start(task) {
      return { id: `test-${Date.now()}`, result: Promise.resolve().then(() => task.role === 'build' ? build(task) : review(task)), dispose: async () => {} };
    } };
}

async function recordedChange(task) {
  await writeFile(path.join(task.workspace, 'builder-note.md'), 'Candidate change; acceptance defects intentionally remain.\n');
  return { summary: 'Builder claims completion' };
}

test('Codex child does not inherit desktop connectors or session execution features', async t => {
  const { root, config } = await setup(t);
  const adapter = createAgentAdapter('codex', { executable: process.execPath, argsPrefix: [fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url))], env: { DSH_PROTOCOL_FIXTURE: 'codex', CODEX_APP_TOOLS_PIPE_PATH: 'poisoned-desktop-pipe', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'desktop' } });
  const handle = await adapter.start({ role: 'review', workspace: config.repository, artifactDir: root, runKey: randomUUID(), permissions: { write: false }, prompt: 'Boundary probe', timeoutMs: 10000 });
  try {
    const result = await handle.result;
    assert.ok(result.args.includes('--ignore-user-config'));
    assert.ok(result.args.includes('mcp_servers={}'));
    for (const feature of ['plugins', 'hooks', 'code_mode', 'code_mode_host', 'multi_agent', 'shell_tool']) assert.ok(result.args.includes(`features.${feature}=false`));
    assert.ok(result.args.includes('web_search="disabled"'));
    assert.ok(result.codexEnvironmentKeys.every(key => key === 'CODEX_HOME'));
  } finally { await handle.dispose(); }
});

test('priority range and host-governance candidates are rejected at the assessment boundary', () => {
  const value = { complete: false, reason: 'evidence', gaps: [{ id: 'gap', description: 'problem', priority: 100, evidence: ['test'] }], candidates: [{ kind: 'write', gapId: 'gap', goal: 'repair', capabilities: ['code'], risk: 'normal', strategy: 'repair' }] };
  assert.equal(validateAssessment(value).gaps[0].priority, 100);
  assert.throws(() => validateAssessment({ ...value, gaps: [{ ...value.gaps[0], priority: 101 }] }), /priority/);
  assert.throws(() => validateAssessment({ ...value, candidates: [{ ...value.candidates[0], kind: 'host_governance' }] }), /governance/);
  assert.throws(() => validateAssessment({ ...value, candidates: [{ ...value.candidates[0], capabilities: ['code/debug'] }] }), /capabilities/);
});

test('native Codex quota errors terminate promptly and remove the provider from selection', async t => {
  const { root, config } = await setup(t);
  const adapter = createAgentAdapter('codex', { executable: process.execPath, argsPrefix: [fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url))], env: { DSH_PROTOCOL_FIXTURE: 'codex', DSH_PROTOCOL_QUOTA: '1' } });
  const handle = await adapter.start({ role: 'build', workspace: config.repository, artifactDir: root, runKey: randomUUID(), permissions: { shell: false }, prompt: 'test', timeoutMs: 10000 });
  try { await assert.rejects(handle.result, /Usage limit/); } finally { await handle.dispose(); }
  assert.equal(adapter.availability, 'offline');
  const registry = new AgentRegistry(); registry.add(adapter);
  registry.add(controlledAdapter('dsh', () => {}, () => {}));
  assert.equal(registry.select({ role: 'build', capabilities: ['code'] }).id, 'dsh');
});

test('decision retries through another available reasoner when its provider exhausts quota', async () => {
  const registry = new AgentRegistry();
  for (const id of ['dsh', 'codex']) registry.add({ ...controlledAdapter(id, () => {}, () => {}), roles: ['decide'] });
  const attempted = [];
  const router = new ModelDecision(async agent => {
    attempted.push(agent.id);
    if (agent.id === 'dsh') { agent.availability = 'offline'; throw new Error('Usage limit exceeded'); }
    return { complete: true, reason: 'accepted evidence', gaps: [], candidates: [] };
  }, registry);
  const report = await router.assess({ goal: 'test', successCriteria: [], constraints: [], failures: [], actions: [], agentPerformance: {} }, {}, '.');
  assert.deepEqual(attempted, ['dsh', 'codex']);
  assert.equal(report.decidedBy, 'codex');
});

test('unaccepted green-test candidates cannot be declared complete by the decision model', async () => {
  const registry = new AgentRegistry();
  registry.add({ ...controlledAdapter('dsh', () => {}, () => {}), roles: ['decide'] });
  let attempts = 0;
  const router = new ModelDecision(async () => ++attempts === 1
    ? { complete: true, reason: 'tests green', gaps: [], candidates: [] }
    : { complete: false, reason: 'unresolved independent review', gaps: [{ id: 'review-finding', description: 'repair finding', priority: 100, evidence: ['review'] }], candidates: [{ kind: 'write', gapId: 'review-finding', goal: 'repair review finding', capabilities: ['code'], risk: 'normal', strategy: 'repair' }] }, registry);
  const report = await router.assess({ goal: 'test', successCriteria: [], constraints: [], failures: [], actions: [], agentPerformance: {} }, { head: 'candidate', acceptedHead: 'accepted', tests: [{ passed: true }] }, '.');
  assert.equal(attempts, 2);
  assert.equal(report.complete, false);
});

test('a no-op cannot create a commit, count success or pass a pending rejected candidate', async t => {
  const { config } = await setup(t);
  const agents = ['code-worker', 'ui-worker'].map(id => controlledAdapter(id, async () => ({}), async () => { throw new Error('No-op must not reach review'); }));
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  const baseline = (await runtime.initialize()).acceptedHead;
  const state = await runtime.start({ maxActions: 1 });
  assert.equal(state.actions[0].phase, 'NO_CHANGE');
  assert.equal(state.actions[0].commit, undefined);
  assert.equal(state.commits.length, 0);
  assert.equal(state.acceptedHead, baseline);
  assert.equal(state.agentPerformance['code-worker'].successes, 0);
});

test('source budget covers backend and frontend, exposes omissions and respects UTF-8 bytes', async t => {
  const { root } = await setup(t);
  await mkdir(path.join(root, 'backend/auth'), { recursive: true });
  await mkdir(path.join(root, 'frontend'), { recursive: true });
  const paths = ['backend/auth/login.ts', 'backend/main.py', 'frontend/page.tsx'];
  for (const file of paths) await writeFile(path.join(root, file), '中文source\n'.repeat(1000));
  const report = await sourceObservation(root, paths.map(name => ({ name, type: 'file' })), 1000);
  assert.ok(report.sources['backend/auth/login.ts']);
  assert.ok(report.sources['frontend/page.tsx']);
  assert.ok(report.sourceCoverage.usedBytes <= 1000);
  assert.equal(report.sourceCoverage.complete, false);
  assert.ok(report.sourceCoverage.included.every(file => file.truncated));
  assert.equal(changedPathRisk(['backend/auth/login.ts']).risk, 'high');
  assert.equal(changedPathRisk(['frontend/page.tsx']).risk, 'normal');
});

test('actual sensitive paths force two independent reviewers despite normal model risk', async t => {
  const { config } = await setup(t);
  const build = async task => {
    const file = path.join(task.workspace, 'checkout.mjs');
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('sum + item.price, 0', 'sum + item.price * item.quantity, 0'));
    await writeFile(path.join(task.workspace, 'style.css'), '.checkout { display: block; }');
    await mkdir(path.join(task.workspace, 'auth'));
    await writeFile(path.join(task.workspace, 'auth/login.mjs'), 'export const validate = value => Boolean(value);');
    return {};
  };
  const agents = ['code-worker', 'ui-worker', 'security-worker'].map(id => controlledAdapter(id, build, async () => ({ verdict: 'pass', reason: 'host evidence', evidence: ['auth/login.mjs'], blockingRisks: [] })));
  agents[1].capabilities = ['code', 'review', 'reason'];
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  const state = await runtime.start({ maxActions: 1 });
  const action = state.actions[0];
  assert.equal(action.risk, 'high');
  assert.equal(action.phase, 'MERGE_READY');
  assert.equal(new Set(action.reviews.map(review => review.reviewer)).size, 2);
  assert.deepEqual(action.riskEvidence.sensitivePaths, ['auth/login.mjs']);
});

test('decision routing starts with DSH, escalates consecutive failures and honors quarantine', async () => {
  const registry = new AgentRegistry();
  for (const id of ['dsh', 'codex', 'pi']) registry.add({ ...controlledAdapter(id, () => {}, () => {}), roles: ['decide'] });
  const chosen = [];
  const router = new ModelDecision(async agent => { chosen.push(agent.id); return { complete: true, reason: 'accepted evidence', gaps: [], candidates: [] }; }, registry);
  const state = { goal: 'test', successCriteria: [], constraints: [], failures: [], actions: [], agentPerformance: {} };
  await router.assess(state, {}, '.');
  state.actions = [{ phase: 'REJECTED' }, { phase: 'NO_CHANGE' }];
  await router.assess(state, {}, '.');
  registry.get('codex').roles = [];
  await router.assess(state, {}, '.');
  assert.deepEqual(chosen, ['dsh', 'codex', 'dsh']);
});

async function assess(state, observation, directory) {
  const source = await readFile(path.join(directory, 'checkout.mjs'), 'utf8');
  const css = await readFile(path.join(directory, 'style.css'), 'utf8');
  const gaps = [];
  if (!source.includes('item.price * item.quantity')) gaps.push({ id: 'quantity', description: 'Incorrect subtotal', priority: 80, evidence: ['functional acceptance test'] });
  // Rejection evidence can reveal a new higher priority regression in unaccepted work.
  if (source.includes('item.price * item.quantity') && source.split('export const delivery')[1].includes('sum + item.price, 0')) gaps.unshift({ id: 'delivery', description: 'New delivery regression', priority: 100, evidence: ['independent failed review and current source'] });
  if (css.includes('display: none')) gaps.push({ id: 'visibility', description: 'Hidden checkout UI', priority: 30, evidence: ['UI acceptance test'] });
  return { complete: gaps.length === 0, reason: gaps.length ? 'Current observed defects' : 'Tests and current state satisfy criteria', projectHealth: gaps.length ? 0.4 : 1, gaps,
    candidates: gaps.map(gap => ({ gapId: gap.id, goal: gap.description, capabilities: [gap.id === 'visibility' ? 'ui' : 'code'], risk: 'normal', strategy: gap.id === 'delivery' ? 'repair' : 'reprioritize', rationale: gap.evidence[0] })) };
}

test('V1 governed fixture: regression rejection, dynamic replan, independent trees, commits and restart', async t => {
  const { config } = await setup(t);
  const builds = [], reviews = [];
  const build = async task => {
    builds.push(task.workspace);
    const file = path.join(task.workspace, 'checkout.mjs');
    let source = await readFile(file, 'utf8');
    if (task.prompt.includes('Goal: Incorrect subtotal')) source = source.replace('sum + item.price, 0', 'sum + item.price * item.quantity, 0');
    else if (task.prompt.includes('Goal: New delivery regression')) source = source.replaceAll('sum + item.price, 0', 'sum + item.price * item.quantity, 0');
    else await writeFile(path.join(task.workspace, 'style.css'), '.checkout { display: block; padding: 16px; }\n');
    await writeFile(file, source);
    return { summary: 'Builder says completed' };
  };
  const review = async task => {
    reviews.push(task.workspace);
    const source = await readFile(path.join(task.workspace, 'checkout.mjs'), 'utf8');
    const brokenDelivery = source.split('export const delivery')[1].includes('sum + item.price, 0');
    return { verdict: brokenDelivery ? 'reject' : 'pass', reason: brokenDelivery ? 'Delivery regression' : 'Source and actual host tests verified', evidence: ['checkout.mjs', 'tests/acceptance.test.mjs'], blockingRisks: brokenDelivery ? ['Wrong delivery charge'] : [] };
  };
  const agents = [controlledAdapter('code-worker', build, review), controlledAdapter('ui-worker', build, review)];
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  const state = await runtime.start({ maxActions: 6 });
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.actions.map(a => a.gapId), ['quantity', 'delivery', 'visibility']);
  assert.deepEqual(state.actions.map(a => a.phase), ['REJECTED', 'REJECTED', 'MERGE_READY']);
  assert.ok(state.actions.every(a => a.commit && a.tests.length && a.reviews.length && a.decisionId && a.rationale));
  assert.equal(new Set([...builds, ...reviews]).size, builds.length + reviews.length);
  assert.equal(state.decisions.length, 4);
  assert.match(state.actions[1].diff, /^\+export const total/m);
  assert.doesNotMatch(state.actions[1].actionDiff, /^\+export const total/m);
  const main = execFileSync('git', ['-C', config.repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notEqual(main, state.acceptedHead);
  assert.match(await readFile(path.join(config.repository, 'style.css'), 'utf8'), /display: none/);
  const resumed = new ProjectRuntime(config, { agents, assessment: assess });
  const restored = await resumed.initialize();
  for (const key of ['goal', 'gaps', 'actions', 'reviews', 'failures', 'decisions', 'evidence', 'agentPerformance', 'commits']) assert.deepEqual(restored[key], state[key]);
});

test('agent registry uses capabilities, risk, availability and failure history', () => {
  const registry = new AgentRegistry();
  const a = controlledAdapter('code-worker', () => {}, () => {}), b = controlledAdapter('ui-worker', () => {}, () => {});
  b.capabilities = ['ui', 'review']; registry.add(a); registry.add(b);
  assert.equal(registry.select({ role: 'build', capabilities: ['code'] }).id, a.id);
  assert.equal(registry.select({ role: 'build', capabilities: ['ui'] }, { [a.id]: { successes: 0, failures: 3, consecutiveFailures: 3 } }).id, b.id);
  b.availability = 'offline'; assert.equal(registry.select({ role: 'build', capabilities: ['ui'] }).id, a.id);
});

test('permissions block external writes, Git metadata and shell bypass for reviewers', async t => {
  const { config } = await setup(t);
  assert.equal(guardPath(config.repository, '../outside.txt'), 'Path outside assigned worktree');
  assert.equal(guardPath(config.repository, '.git/config'), 'Git metadata is Controller-owned');
  assert.equal(denyTool(config.repository, { write: false }, 'write', { path: 'a.txt' }), 'Reviewer is read-only');
  assert.equal(denyTool(config.repository, { write: false }, 'bash', { command: 'echo bad > a.txt' }), 'Tool not permitted by Control Plane');
  assert.equal(guardPath(config.repository, 'checkout.mjs'), undefined);
});

test('real process adapter captures output, error, status and cancellation', async t => {
  const { root, config } = await setup(t);
  const adapter = new ProcessAdapter({ id: 'child' }, async () => ({ executable: process.execPath, args: ['-e', 'console.log(JSON.stringify({summary:"ok"}))'], stdin: '', finish: parseObject }));
  const run = await adapter.start({ workspace: config.repository, artifactDir: root, timeoutMs: 10000 });
  assert.equal((await run.result).summary, 'ok'); await run.dispose(); assert.equal(adapter.status(run.id), 'completed');
  const sleeper = new ProcessAdapter({ id: 'sleeper' }, async () => ({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], finish: parseObject }));
  const sleeping = await sleeper.start({ workspace: config.repository, artifactDir: root, timeoutMs: 10000 });
  const rejected = assert.rejects(sleeping.result, /interrupted/); await sleeping.dispose(); await rejected;
  assert.equal(sleeper.status(sleeping.id), 'failed');
});

test('host tests fail even if Builder and Reviewer both claim pass', async t => {
  const { config } = await setup(t);
  const agents = ['code-worker', 'ui-worker'].map(id => controlledAdapter(id, recordedChange, async () => ({ verdict: 'pass', reason: 'claimed', evidence: ['claim'], blockingRisks: [] })));
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  const state = await runtime.start({ maxActions: 1 });
  assert.equal(state.actions[0].phase, 'REJECTED');
  assert.equal(state.commits[0].status, 'candidate');
});

test('protected test mutation cannot become merge-ready', async t => {
  const { config } = await setup(t);
  const agents = ['code-worker', 'ui-worker'].map(id => controlledAdapter(id, async task => {
    await writeFile(path.join(task.workspace, 'tests/acceptance.test.mjs'), '// forged passing tests'); return {};
  }, async () => ({ verdict: 'pass', reason: 'claim', evidence: ['claim'], blockingRisks: [] })));
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  const state = await runtime.start({ maxActions: 1 });
  assert.equal(state.actions[0].protectedIntact, false);
  assert.equal(state.actions[0].phase, 'REJECTED');
});

test('server protects mutation requests and renders unconfigured UI', async t => {
  const server = createControlServer(null, { port: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).agents.length, 4);
  assert.equal((await fetch(`${base}/api/start`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/start`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-DSH-Control': '1' }, body: '{}' })).status, 409);
});

test('all four CLI adapters expose the same lifecycle contract', () => {
  for (const provider of ['codex', 'opencode', 'pi', 'dsh']) {
    const adapter = createAgentAdapter(provider);
    for (const method of ['start', 'send', 'cancel', 'status', 'result']) assert.equal(typeof adapter[method], 'function', `${provider}.${method}`);
  }
});

test('four native transports launch and parse their published JSON/RPC formats', async t => {
  const { root, config } = await setup(t);
  const entry = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));
  for (const provider of ['codex', 'opencode', 'pi', 'dsh']) {
    const adapter = createAgentAdapter(provider, { executable: process.execPath, argsPrefix: [entry], env: { DSH_PROTOCOL_FIXTURE: provider } });
    const handle = await adapter.start({ role: 'review', workspace: config.repository, artifactDir: path.join(root, provider), runKey: provider, permissions: { write: false }, prompt: 'Protocol test', timeoutMs: 10_000 });
    try { assert.equal((await handle.result).summary, 'protocol-ok', provider); } finally { await handle.dispose(); }
    assert.equal(adapter.status(handle.id), 'completed');
  }
});

test('OpenCode carries large Unicode review evidence through an attachment and retains its recovery token', async t => {
  const { root, config } = await setup(t);
  const entry = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));
  const adapter = createAgentAdapter('opencode', { executable: process.execPath, argsPrefix: [entry], env: { DSH_PROTOCOL_FIXTURE: 'opencode' } });
  const runKey = randomUUID();
  const prompt = '独立审核证据\n'.repeat(20000) + 'END-OF-EVIDENCE';
  const handle = await adapter.start({ role: 'review', workspace: config.repository, artifactDir: root, runKey, permissions: { write: false }, prompt, timeoutMs: 10_000 });
  try {
    const result = await handle.result;
    assert.ok(result.prompt.includes(prompt), 'Complete evidence including its tail reaches the child');
    assert.ok(result.prompt.length < prompt.length + 2000);
    assert.ok(result.args.join(' ').length < 4000);
    assert.ok(result.args.some(arg => arg.includes(runKey)));
    assert.equal(adapter.status(handle.id), 'completed');
  } finally { await handle.dispose(); }
});

test('concurrent OpenCode calls without run keys keep separate prompt attachments', async t => {
  const { root, config } = await setup(t);
  const entry = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));
  const adapter = createAgentAdapter('opencode', { executable: process.execPath, argsPrefix: [entry], env: { DSH_PROTOCOL_FIXTURE: 'opencode' } });
  const specs = await Promise.all(['first evidence', 'second evidence'].map(prompt => adapter.prepare({ role: 'review', workspace: config.repository, artifactDir: root, permissions: { write: false }, prompt })));
  const files = specs.map(spec => spec.args[spec.args.indexOf('--file') + 1]);
  assert.notEqual(files[0], files[1]);
  assert.ok((await readFile(files[0], 'utf8')).includes('first evidence'));
  assert.ok((await readFile(files[1], 'utf8')).includes('second evidence'));
});

test('worker crash persists failure and reassigns the next action', async t => {
  const { config } = await setup(t);
  const broken = controlledAdapter('code-worker', async () => { throw new Error('worker killed'); }, async () => {});
  const good = controlledAdapter('ui-worker', async () => ({}), async () => ({ verdict: 'reject', reason: 'source unchanged', evidence: ['tests'], blockingRisks: ['defects remain'] }));
  const runtime = new ProjectRuntime(config, { agents: [broken, good], assessment: assess });
  const state = await runtime.start({ maxActions: 1 });
  assert.equal(state.actions[0].phase, 'FAILED');
  assert.match(state.failures[0].error, /worker killed/);
  assert.equal(runtime.registry.select({ role: 'build', capabilities: ['code'] }, state.agentPerformance).id, 'ui-worker');
  assert.deepEqual((await runtime.store.load()).failures, state.failures);
});

test('explicit recovery preserves an interrupted action for replanning', async t => {
  const { config } = await setup(t);
  const runtime = new ProjectRuntime(config);
  await runtime.initialize();
  runtime.state.actions.push({ id: 'interrupted', phase: 'BUILDING' });
  await runtime.checkpoint();
  const state = await recoverInterruptedProject(config);
  assert.equal(state.actions[0].phase, 'FAILED');
  assert.equal(state.status, 'paused');
  assert.equal(state.failures.length, 1);
});

test('missing review fields cannot pass and retry budget halts the gate', async t => {
  const { config } = await setup(t);
  config.maxReviewAttempts = 1;
  const agents = ['code-worker', 'ui-worker'].map(id => controlledAdapter(id, recordedChange, async () => ({ verdict: 'pass', reason: 'claim', evidence: ['claim'] })));
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  await assert.rejects(runtime.start({ maxActions: 1 }), /Invalid independent review/);
  assert.equal(runtime.state.actions[0].phase, 'HALTED');
  assert.equal(runtime.state.acceptedHead, runtime.state.actions[0].acceptedBase);
});

test('an alias of the Builder identity cannot review its changes', async t => {
  const { config } = await setup(t);
  const agents = ['code-worker', 'ui-worker'].map(id => controlledAdapter(id, recordedChange, async () => ({ verdict: 'pass', reason: 'claim', evidence: ['claim'], blockingRisks: [] })));
  agents.forEach(agent => { agent.identity = 'shared-session'; });
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  await assert.rejects(runtime.start({ maxActions: 1 }), /retry budget exhausted/);
  assert.equal(runtime.state.actions[0].phase, 'HALTED');
});

test('recovery lock excludes a new controller and persisted host policy is immutable', async t => {
  const { root, config } = await setup(t);
  const runtime = new ProjectRuntime(config);
  await runtime.initialize();
  await writeFile(path.join(config.stateDir, 'recovery.lock'), '{}');
  await assert.rejects(new WorldStore(config.stateDir).acquire(), /Recovery is in progress/);
  await rm(path.join(config.stateDir, 'recovery.lock'));
  const changed = new ProjectRuntime({ ...config, tests: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'] }] });
  await assert.rejects(changed.initialize(), /Host tests or constraints differ/);
});

test('transient reviewer failure retries independently without another Builder', async t => {
  const { config } = await setup(t);
  let builds = 0, reviews = 0;
  const agents = ['code-worker', 'ui-worker'].map(id => controlledAdapter(id, async task => { builds++; return recordedChange(task); }, async () => {
    if (++reviews === 1) throw new Error('transient reviewer failure');
    return { verdict: 'reject', reason: 'actual tests fail', evidence: ['host tests'], blockingRisks: ['defects'] };
  }));
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  const state = await runtime.start({ maxActions: 1 });
  assert.equal(builds, 1); assert.equal(reviews, 2);
  assert.equal(state.actions[0].phase, 'REJECTED');
  assert.equal(state.actions[0].reviewAttempts, 2);
});

test('ignored dependency cannot pass clean committed-tree tests', async t => {
  const { config } = await setup(t);
  const build = async task => {
    await writeFile(path.join(task.workspace, '.gitignore'), 'hidden.mjs\n');
    await writeFile(path.join(task.workspace, 'hidden.mjs'), 'export const total = items => items.reduce((sum,item)=>sum+item.price*item.quantity,0); export const delivery = items => total(items)>=30?0:5;\n');
    await writeFile(path.join(task.workspace, 'checkout.mjs'), "export { total, delivery } from './hidden.mjs';\n");
    await writeFile(path.join(task.workspace, 'style.css'), '.checkout { display:block; }\n');
    return {};
  };
  const agents = ['code-worker', 'ui-worker'].map(id => controlledAdapter(id, build, async () => ({ verdict: 'pass', reason: 'claim', evidence: ['Builder tests'], blockingRisks: [] })));
  const runtime = new ProjectRuntime(config, { agents, assessment: assess });
  const state = await runtime.start({ maxActions: 1 });
  assert.equal(state.actions[0].tests.every(test => test.passed), true);
  assert.equal(state.actions[0].committedTests.every(test => test.passed), false);
  assert.equal(state.actions[0].phase, 'REJECTED');
});

test('recovery stops a Worker spawned before PID publication using the durable launch token', async t => {
  const { root, config } = await setup(t);
  const token = randomUUID();
  const adapter = new ProcessAdapter({ id: 'orphan' }, async () => ({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)', token], finish: parseObject }));
  const handle = await adapter.start({ workspace: config.repository, artifactDir: root, timeoutMs: 30000 });
  t.after(() => handle.dispose());
  const result = assert.rejects(handle.result);
  const runtime = new ProjectRuntime(config); await runtime.initialize();
  runtime.state.actions.push({ id: 'crash-before-pid', phase: 'BUILDING' });
  runtime.state.runs.push({ id: token, launchToken: token, status: 'preparing' });
  await runtime.checkpoint();
  const recovered = await recoverInterruptedProject(config);
  await result;
  assert.equal(recovered.runs[0].status, 'interrupted');
  assert.equal(recovered.actions[0].phase, 'FAILED');
});

test('Windows job stops descendants even when the Worker launcher exits first', { skip: process.platform !== 'win32' }, async t => {
  const { root, config } = await setup(t);
  const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref(); console.log(JSON.stringify({pid:child.pid}));";
  const adapter = new ProcessAdapter({ id: 'parent-exits-first' }, async () => ({ executable: process.execPath, args: ['-e', script], finish: parseObject }));
  const handle = await adapter.start({ workspace: config.repository, artifactDir: root, timeoutMs: 15000 });
  try { const report = await handle.result; assert.equal(await processFingerprint(report.pid), null); }
  finally { await handle.dispose(); }
});
