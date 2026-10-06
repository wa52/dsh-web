import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';

async function projectFixture(t, { models, failureKind = 'quota', task = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-quota-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createCheckoutFixture(path.join(root, 'repo'));
  const log = [];
  const initial = worker('opencode', 'opencode', {
    async run(input) {
      await writeFile(path.join(input.workspace, 'partial.txt'), 'preserve this work');
      if (failureKind === 'quota') this.availability = 'offline';
      const message = {
        quota: 'Usage limit exceeded',
        transport: 'transport unavailable',
        length: 'OpenCode output exhausted at length finish',
        'empty-output': 'Empty research response',
        timeout: 'Agent run budget exceeded',
      }[failureKind];
      throw Object.assign(new Error(message), { failureKind });
    },
  }, log);
  const fallback = worker('pi', 'pi', {
    async run(input) {
      assert.equal(await readFile(path.join(input.workspace, 'partial.txt'), 'utf8'), 'preserve this work');
      assert.ok(log.some(event => event.type === 'stopped' && event.id === 'opencode'), 'fallback must start only after confirmed stop');
      return { summary: 'continued' };
    },
  }, log);
  const config = {
    ...fixture,
    stateDir: path.join(root, 'state'),
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
    permissions: { read: true, write: true, shell: false, network: false },
    models,
    commercialLoop: { enabled: true, worker: 'opencode', references: [] },
  };
  const runtime = new ProjectRuntime(config, { agents: [initial, fallback] });
  await runtime.initialize();
  const tree = await runtime.worktrees.create(randomUUID(), 'build', runtime.state.acceptedHead);
  const action = { id: randomUUID(), phase: 'BUILDING', builder: initial.id, builderIdentity: initial.identity, builderHistory: [initial.id], builderIdentities: [initial.identity] };
  runtime.state.actions.push(action);
  const result = await runtime.executeWithHandoff(initial, {
    role: 'build', actionId: action.id, workspace: tree.directory, capabilities: ['code'],
    risk: 'normal', prompt: 'continue bounded action', ...task,
  });
  return { runtime, action, result, log };
}

function worker(id, provider, behavior, log) {
  return {
    id, identity: `${id}-identity`, provider, roles: ['build'], capabilities: ['code', 'security'], availability: 'online',
    describe() { return { id, identity: this.identity, provider, roles: this.roles, availability: this.availability }; },
    async start(task) {
      log.push({ type: 'start', id, model: task.model, role: task.role });
      return {
        id: task.runKey,
        result: Promise.resolve().then(() => behavior.call(this, task)),
        dispose: async () => { log.push({ type: 'stopped', id, role: task.role }); },
      };
    },
  };
}

test('quota and transport handoffs continue normal actions on routine fallbacks with partial work intact', async t => {
  for (const failureKind of ['quota', 'transport']) await t.test(failureKind, async sub => {
    const run = await projectFixture(sub, { failureKind, models: [
      { id: 'oc-routine', provider: 'opencode', tier: 'routine' },
      { id: 'pi-routine', provider: 'pi', tier: 'routine' },
      { id: 'pi-deep', provider: 'pi', tier: 'deep' },
    ] });
    assert.equal(run.result.worker, 'pi');
    assert.deepEqual(run.action.builderHistory, ['opencode', 'pi']);
    assert.equal(run.log.filter(event => event.type === 'start').length, 2, 'handoff retries remain bounded to the eligible successor');
    const persisted = await run.runtime.store.load();
    assert.equal(persisted.handoffs[0].failureKind, failureKind);
    assert.equal(persisted.handoffs[0].from, 'opencode');
    assert.equal(persisted.handoffs[0].to, 'pi');
    assert.ok(persisted.handoffs[0].unavailableModels.includes('oc-routine'), 'failed model is excluded and persisted');
    assert.equal(persisted.handoffs[0].failureRouting.selectedModel, 'oc-routine');
    const routedBuilds = persisted.runs.filter(record => record.role === 'build' && record.routing);
    assert.equal(routedBuilds[0].routing.selectedModel, 'oc-routine');
    assert.equal(routedBuilds[1].routing.selectedModel, 'pi-routine');
    assert.equal(routedBuilds[1].routing.inputs.escalate, false);
    assert.equal(routedBuilds[1].routing.inputs.requiredTier, 'routine');
  });
});

test('quota continuation retains pre-existing high-risk and security model tiers', async t => {
  for (const scenario of [
    { name: 'high-risk', task: { risk: 'high' }, models: [
      { id: 'oc-deep', provider: 'opencode', tier: 'deep' },
      { id: 'pi-routine', provider: 'pi', tier: 'routine' },
      { id: 'pi-deep', provider: 'pi', tier: 'deep' },
    ], expected: 'pi-deep', tier: 'deep' },
    { name: 'security', task: { security: true }, models: [
      { id: 'oc-security', provider: 'opencode', tier: 'security' },
      { id: 'pi-routine', provider: 'pi', tier: 'routine' },
      { id: 'pi-security', provider: 'pi', tier: 'security' },
    ], expected: 'pi-security', tier: 'security' },
  ]) await t.test(scenario.name, async sub => {
    const run = await projectFixture(sub, { models: scenario.models, task: scenario.task });
    assert.equal(run.result.worker, 'pi');
    const persisted = await run.runtime.store.load();
    const continuation = persisted.runs.filter(record => record.role === 'build' && record.routing).at(-1).routing;
    assert.equal(continuation.selectedModel, scenario.expected);
    assert.equal(continuation.inputs.requiredTier, scenario.tier);
    assert.equal(continuation.inputs.escalate, false, 'quota itself must not manufacture escalation');
  });
});

test('quota handoff preserves an escalation already required by the task', async t => {
  const run = await projectFixture(t, { task: { escalate: true }, models: [
    { id: 'oc-deep', provider: 'opencode', tier: 'deep' },
    { id: 'pi-routine', provider: 'pi', tier: 'routine' },
    { id: 'pi-deep', provider: 'pi', tier: 'deep' },
  ] });
  const persisted = await run.runtime.store.load();
  const continuation = persisted.runs.filter(record => record.role === 'build' && record.routing).at(-1).routing;
  assert.equal(continuation.selectedModel, 'pi-deep');
  assert.equal(continuation.inputs.escalate, true);
});

test('length, empty-output and invocation-timeout failures still escalate normal actions', async t => {
  for (const failureKind of ['length', 'empty-output', 'timeout']) await t.test(failureKind, async sub => {
    const run = await projectFixture(sub, { failureKind, models: [
      { id: 'oc-routine', provider: 'opencode', tier: 'routine' },
      { id: 'pi-routine', provider: 'pi', tier: 'routine' },
      { id: 'pi-deep', provider: 'pi', tier: 'deep' },
    ] });
    const persisted = await run.runtime.store.load();
    assert.equal(persisted.handoffs[0].failureKind, failureKind);
    const continuation = persisted.runs.filter(record => record.role === 'build' && record.routing).at(-1).routing;
    assert.equal(continuation.selectedModel, 'pi-deep');
    assert.equal(continuation.inputs.requiredTier, 'deep');
    assert.equal(continuation.inputs.escalate, true);
    assert.match(continuation.reason, /higher-tier/);
  });
});
