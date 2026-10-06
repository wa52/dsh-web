import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ProjectRuntime } from '../runtime/project.mjs';
import { ProcessAdapter } from '../runtime/process.mjs';
import { createAgentAdapter, decodeAnswer } from '../runtime/adapters.mjs';
import { AgentRegistry } from '../runtime/registry.mjs';
import { routeModel } from '../runtime/routing.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';

// Additive regressions for the frozen routing-resilience failures. These drive
// the real process adapter, model router, registry, ProjectRuntime handoff, and
// CommercialLoop reviewer-selection seams; every agent/model is a deterministic
// local test double. Passing these tests is policy evidence, not product success.

const cliFixture = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));

async function projectFixture(t, { agents = [], commercialLoop = { enabled: true, worker: 'decision', references: [{ url: 'https://example.test/reference', text: 'A verified reference document.' }] }, models } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-routing-resilience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createCheckoutFixture(path.join(root, 'repo'));
  const config = {
    ...fixture,
    stateDir: path.join(root, 'state'),
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
    permissions: { read: true, write: true, shell: false, network: false },
    agentTimeoutMs: 10_000,
    maxReviewAttempts: 8,
    ...(models ? { models } : {}),
    commercialLoop,
  };
  const runtime = new ProjectRuntime(config, { agents });
  await runtime.initialize();
  return { root, config, runtime };
}

function worker(id, { identity = `${id}-identity`, provider = 'test-double', roles = ['build', 'decide', 'review'], capabilities = ['reason', 'code', 'review', 'security'], trust = 0.8, cost = 1, quotaGroup, behavior, log = [] } = {}) {
  return {
    id, identity, provider, roles, capabilities, trust, cost, quotaGroup, availability: 'online',
    describe() { return { id, identity, provider, roles, availability: this.availability }; },
    async start(task) {
      log.push({ type: 'start', id, role: task.role });
      return {
        id: randomUUID(),
        result: Promise.resolve().then(() => behavior ? behavior.call(this, task, log) : ({ text: 'Research completed.' })),
        dispose: async () => { log.push({ type: 'stopped', id, role: task.role }); },
      };
    },
  };
}

function processTask(root, overrides = {}) {
  return {
    role: 'build', workspace: root, artifactDir: root, runKey: randomUUID(),
    prompt: 'deterministic lifecycle probe', timeoutMs: 10_000, permissions: { write: false },
    ...overrides,
  };
}

test('one invocation timeout is typed and does not quarantine shared-account peers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-timeout-classification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new ProcessAdapter({ id: 'codex', provider: 'codex', quotaGroup: 'shared-codex-account', availability: 'online', roles: ['build'], capabilities: ['code'] }, async task => ({
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)', task.runKey],
    finish: () => ({}),
  }));
  const handle = await adapter.start(processTask(root, { timeoutMs: 100 }));
  const peer = { id: 'pi', provider: 'pi', quotaGroup: 'shared-codex-account', availability: 'online', roles: ['build'], capabilities: ['code'], start() {} };
  const registry = new AgentRegistry();
  registry.add(adapter); registry.add(peer);
  try {
    await assert.rejects(handle.result, error => {
      assert.equal(error.failureKind, 'timeout');
      return true;
    });
  } finally { await handle.dispose(); }
  assert.notEqual(adapter.availability, 'offline', 'an invocation timeout is not account quota evidence');
  assert.equal(registry.isUnavailable('pi'), false, 'a timeout must not quarantine the actual quotaGroup peer');
  assert.equal(registry.select({ role: 'build', capabilities: ['code'], exclude: ['codex'] }).id, 'pi');
});

test('local spawn/transport failure does not falsely quarantine shared-account peers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-spawn-classification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new ProcessAdapter({ id: 'codex', provider: 'codex', quotaGroup: 'shared-codex-account', availability: 'online' }, async task => ({
    executable: path.join(root, 'missing-native-worker'), args: [task.runKey], finish: () => ({}),
  }));
  const peer = { id: 'pi', provider: 'pi', quotaGroup: 'shared-codex-account', availability: 'online', roles: ['build'], capabilities: ['code'], start() {} };
  const registry = new AgentRegistry(); registry.add(adapter); registry.add(peer);
  // On Windows the native launch is wrapped in a supervisor process, so spawn may
  // succeed and the transport failure surfaces on handle.result. Accept either seam.
  let handle;
  try { handle = await adapter.start(processTask(root)); }
  catch (error) {
    assert.equal(error.failureKind, 'transport');
  }
  if (handle) {
    try { await assert.rejects(handle.result, error => error.failureKind === 'transport'); }
    finally { await handle.dispose(); }
  }
  assert.notEqual(adapter.availability, 'offline', 'a local executable/transport fault is not account quota evidence');
  assert.equal(registry.isUnavailable('pi'), false);
});

test('a real quota error still quarantines every declared shared-account member, including Pi', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-quota-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codex = createAgentAdapter('codex', {
    executable: process.execPath,
    argsPrefix: [cliFixture],
    env: { DSH_PROTOCOL_FIXTURE: 'codex', DSH_PROTOCOL_QUOTA: '1' },
    quotaGroup: 'codex-account',
  });
  const pi = { id: 'pi', provider: 'pi', quotaGroup: 'codex-account', availability: 'online', roles: ['build'], capabilities: ['code'], start() {} };
  const dsh = { id: 'dsh', provider: 'dsh', availability: 'online', roles: ['build'], capabilities: ['code'], start() {} };
  const registry = new AgentRegistry(); registry.add(codex); registry.add(pi); registry.add(dsh);
  const handle = await codex.start({ ...processTask(root), role: 'build', runKey: randomUUID(), timeoutMs: 10_000 });
  try { await assert.rejects(handle.result, /Usage limit exceeded/); }
  finally { await handle.dispose(); }
  assert.equal(codex.availability, 'offline');
  assert.equal(registry.isUnavailable('codex'), true);
  assert.equal(registry.isUnavailable('pi'), true, 'Pi is an actual Codex quotaGroup member');
  assert.equal(registry.isUnavailable('dsh'), false);
});

test('native OpenCode finish-length frame retains safe finish reason and usage counters', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-opencode-length-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = {
    type: 'step_finish', timestamp: 1, sessionID: 'fixture-session',
    part: { type: 'step-finish', reason: 'length', cost: 0, tokens: { total: 37_000, input: 5_000, output: 0, reasoning: 32_000, cache: { read: 0, write: 0 } } },
  };
  const replay = path.join(root, 'opencode-frame.mjs');
  await writeFile(replay, `process.stdout.write(${JSON.stringify(JSON.stringify(frame) + '\n')});\n`);
  const opencode = createAgentAdapter('opencode', { executable: process.execPath, argsPrefix: [replay] });
  const handle = await opencode.start({ ...processTask(root), role: 'build', outputFormat: 'text', runKey: randomUUID() });
  let failure;
  try { await handle.result; } catch (error) { failure = error; }
  finally { await handle.dispose(); }
  assert.ok(failure, 'zero visible text after a native length finish must reject with exhaustion evidence');
  assert.equal(failure.failureKind, 'length');
  assert.equal(failure.finishReason, 'length');
  assert.deepEqual(failure.usage, { total: 37_000, input: 5_000, output: 0, reasoning: 32_000, cache: { read: 0, write: 0 } });
  assert.doesNotMatch(JSON.stringify(failure), /hidden reasoning|private chain of thought/i);
  assert.deepEqual(decodeAnswer('Visible answer', 'text'), { text: 'Visible answer' });
  assert.throws(() => decodeAnswer('', 'text'), /Empty research response/, 'ordinary empty output remains distinguishable');

  const textReplay = path.join(root, 'opencode-text.mjs');
  await writeFile(textReplay, `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'text', part: { text: '{"summary":"ok"}' } }) + '\n')});\n`);
  const successful = createAgentAdapter('opencode', { executable: process.execPath, argsPrefix: [textReplay] });
  const ok = await successful.start({ ...processTask(root), role: 'build', outputFormat: 'json', runKey: randomUUID() });
  try { assert.deepEqual((await ok.result).summary, 'ok'); }
  finally { await ok.dispose(); }
});

test('confirmed-stop commercial handoff preserves partial workspace and persists bounded eligible model change', async t => {
  for (const failureKind of ['length', 'empty-output', 'timeout']) await t.test(`${failureKind} failure`, async sub => {
  const models = [
    { id: 'oc-deep', provider: 'opencode', tier: 'deep', cost: 3 },
    { id: 'pi-deep', provider: 'pi', tier: 'deep', cost: 3 },
    { id: 'pi-security', provider: 'pi', tier: 'security', cost: 4 },
    { id: 'prohibited-cheap', provider: 'pi', tier: 'deep', cost: 0, prohibited: true },
  ];
  const log = [];
  const opencode = worker('opencode', { provider: 'opencode', roles: ['build'], capabilities: ['code'], behavior: async function (task) {
    await writeFile(path.join(task.workspace, 'partial.txt'), 'preserve this in the same action');
    this.availability = 'offline';
    const messages = { length: 'OpenCode output exhausted at length finish', 'empty-output': 'Empty research response', timeout: 'Agent run budget exceeded' };
    const error = Object.assign(new Error(messages[failureKind]), { failureKind });
    throw error;
  }, log });
  const pi = worker('pi', { provider: 'pi', roles: ['build'], capabilities: ['code'], behavior: async task => {
    assert.equal(await readFile(path.join(task.workspace, 'partial.txt'), 'utf8'), 'preserve this in the same action');
    assert.ok(log.some(event => event.type === 'stopped' && event.id === 'opencode'), 'successor must not start before the failed worker stops');
    return { summary: 'continued same action' };
  }, log });
  const { runtime } = await projectFixture(sub, { agents: [opencode, pi], models, commercialLoop: { enabled: true, worker: 'opencode', references: [] } });
  const tree = await runtime.worktrees.create(randomUUID(), 'build', runtime.state.acceptedHead);
  const action = { id: randomUUID(), phase: 'BUILDING', builder: 'opencode', builderIdentity: opencode.identity, builderHistory: ['opencode'], builderIdentities: [opencode.identity] };
  runtime.state.actions.push(action);
  const result = await runtime.executeWithHandoff(opencode, { role: 'build', actionId: action.id, workspace: tree.directory, capabilities: ['code'], risk: 'high', prompt: 'continue bounded action' });
  assert.equal(result.worker, 'pi');
  assert.deepEqual(action.builderHistory, ['opencode', 'pi']);
  assert.deepEqual(action.builderIdentities, [opencode.identity, pi.identity]);
  assert.equal(log.filter(event => event.type === 'start' && event.role === 'build').length, 2);
  const persisted = await runtime.store.load();
  assert.equal(persisted.handoffs.length, 1);
  assert.equal(persisted.handoffs[0].from, 'opencode');
  assert.equal(persisted.handoffs[0].to, 'pi');
  assert.equal(persisted.handoffs[0].attempt, 1, 'the persisted handoff records bounded retry progress');
  const routedBuilds = persisted.runs.filter(run => run.role === 'build' && run.routing);
  assert.equal(routedBuilds[0].routing.selectedModel, 'oc-deep');
  assert.equal(routedBuilds[1].routing.selectedModel, 'pi-deep');
  assert.notEqual(routedBuilds[0].routing.selectedModel, routedBuilds[1].routing.selectedModel);
  assert.ok(routedBuilds.every(run => run.routing.selectedModel !== 'prohibited-cheap'));
  assert.match(routedBuilds[1].routing.reason, /higher-tier/);
  assert.equal(routedBuilds[1].routing.inputs.requiredTier, 'deep', 'a high-risk continuation cannot silently downgrade');
  assert.equal(persisted.handoffs[0].failureKind, failureKind);
  });
});

function commercialAgent(id, { identity = `${id}-identity`, trust = 0.8, unavailableOnReview = false, stopUnconfirmed = false, starts = [], stopped = [], failed = [] } = {}) {
  return {
    id, identity, provider: 'test-double', roles: ['decide', 'review', 'build'], capabilities: ['reason', 'review', 'code'], trust, cost: 1, availability: 'online',
    describe() { return { id, identity, provider: this.provider, roles: this.roles, availability: this.availability }; },
    async start(task) {
      starts.push({ id, role: task.role });
      if (task.role === 'review') {
        assert.equal(task.permissions.write, false, 'alignment reviewers retain read-only source access');
        assert.equal(task.permissions.shell, false);
      }
      if (task.role === 'review' && failed.length) {
        assert.ok(failed.every(prior => stopped.includes(prior)), 'every failed reviewer must be confirmed stopped before the next start');
      }
      const result = Promise.resolve().then(() => {
        if (task.role === 'decide') return { text: 'The supplied source and project evidence support this bounded route.' };
        if (task.role === 'review' && unavailableOnReview) {
          this.availability = 'offline';
          failed.push(id);
          throw new Error(id.includes('quota') ? 'Usage limit exceeded' : 'Reviewer transport unavailable');
        }
        return { outcome: 'PASS', reason: 'Stage evidence independently checked', evidence: ['project snapshot', 'verified reference'], blockers: [] };
      });
      return { id: randomUUID(), result, dispose: async () => {
        if (task.role === 'review' && stopUnconfirmed) throw new Error('unable to confirm reviewer process termination');
        stopped.push(id);
      } };
    },
  };
}

async function runAlignmentStage(t, { failIds = [], stopUnconfirmedId } = {}) {
  const starts = [], stopped = [], failed = [];
  const decision = commercialAgent('decision', { starts, stopped, failed });
  const builder = commercialAgent('builder', { identity: 'shared-builder-identity', starts, stopped, failed });
  const alias = commercialAgent('builder-alias', { identity: 'shared-builder-identity', starts, stopped, failed });
  const reviewers = ['quota-reviewer-1', 'transport-reviewer-2', 'quota-reviewer-3', 'transport-reviewer-4', 'independent-reviewer-5']
    .map((id, index) => commercialAgent(id, { trust: 1 - index * 0.01, unavailableOnReview: failIds.includes(id), stopUnconfirmed: id === stopUnconfirmedId, starts, stopped, failed }));
  const { runtime } = await projectFixture(t, { agents: [decision, builder, alias, ...reviewers] });
  const tree = await runtime.worktrees.create(randomUUID(), 'observe', runtime.state.acceptedHead);
  const action = { id: randomUUID(), builder: builder.id, builderIdentity: builder.identity, builderHistory: [builder.id], builderIdentities: [builder.identity] };
  return { runtime, tree, action, starts, stopped, failed };
}

test('commercial alignment tries every remaining independent reviewer after more than two unavailable failures', async t => {
  const { runtime, tree, action, starts, stopped } = await runAlignmentStage(t, {
    failIds: ['quota-reviewer-1', 'transport-reviewer-2', 'quota-reviewer-3', 'transport-reviewer-4'],
  });
  const record = await runtime.commercial.stage('plan', { snapshot: { hash: 'test-snapshot' } }, tree, action);
  assert.equal(record.audit.outcome, 'PASS');
  assert.equal(record.reviewer, 'independent-reviewer-5');
  const attempted = starts.filter(entry => entry.role === 'review').map(entry => entry.id);
  assert.deepEqual(attempted, ['quota-reviewer-1', 'transport-reviewer-2', 'quota-reviewer-3', 'transport-reviewer-4', 'independent-reviewer-5']);
  assert.ok(!attempted.includes('builder-alias'), 'all identities belonging to the Builder are excluded');
  assert.ok(stopped.includes('transport-reviewer-4'), 'the last unavailable reviewer stopped before the successful start');
});

test('commercial reviewer exhaustion and STOP_UNCONFIRMED remain fail-closed', async t => {
  await t.test('all eligible reviewers unavailable', async sub => {
    const ids = ['quota-reviewer-1', 'transport-reviewer-2', 'quota-reviewer-3', 'transport-reviewer-4', 'independent-reviewer-5'];
    const run = await runAlignmentStage(sub, { failIds: ids });
    await assert.rejects(run.runtime.commercial.stage('plan', { snapshot: { hash: 'test-snapshot' } }, run.tree, run.action));
    assert.equal(run.starts.filter(entry => entry.role === 'review').length, ids.length);
    assert.equal(run.runtime.state.alignments.length, 0, 'exhaustion cannot be converted into a PASS alignment');
  });
  await t.test('unconfirmed stop prevents fallback start', async sub => {
    const run = await runAlignmentStage(sub, { failIds: ['quota-reviewer-1'], stopUnconfirmedId: 'quota-reviewer-1' });
    await assert.rejects(run.runtime.commercial.stage('plan', { snapshot: { hash: 'test-snapshot' } }, run.tree, run.action), /STOP_UNCONFIRMED/);
    assert.deepEqual(run.starts.filter(entry => entry.role === 'review').map(entry => entry.id), ['quota-reviewer-1']);
    assert.equal(run.runtime.state.alignments.length, 0);
  });
});

test('failure-driven escalation refuses prohibited or unavailable stronger-tier choices', () => {
  const catalog = [
    { id: 'routine', provider: 'platform', tier: 'routine' },
    { id: 'prohibited-stronger', provider: 'platform', tier: 'deep', prohibited: true },
  ];
  assert.throws(() => routeModel({ provider: 'platform', escalate: true, role: 'build' }, catalog), error => error.code === 'NO_ELIGIBLE_MODEL');
});
