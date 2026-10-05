import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { routeModel, normalizeModelRegistry, unavailableAgentIds, RoutingError } from '../runtime/routing.mjs';
import { AgentRegistry } from '../runtime/registry.mjs';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { ModelDecision } from '../runtime/decision.mjs';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';

// Additive deterministic coverage for Host-supplied automatic per-action model
// routing. No pre-existing test, adapter transport, permission or quota handoff
// behavior is edited; these tests use pure functions and test-double agents.

const routine = tier => ({ id: `flash-${tier}`, provider: 'opencode', tier, cost: 1 });

test('routeModel switches routine, high-risk, escalated and security actions by metadata', () => {
  const catalog = [
    { id: 'oc-flash', provider: 'opencode', tier: 'routine', cost: 1 },
    { id: 'oc-deep', provider: 'opencode', tier: 'deep', cost: 3 },
    { id: 'oc-guard', provider: 'opencode', tier: 'security', cost: 4 },
  ];
  assert.equal(routeModel({ provider: 'opencode' }, catalog).selectedModel, 'oc-flash');
  assert.equal(routeModel({ provider: 'opencode', risk: 'high' }, catalog).selectedModel, 'oc-deep');
  assert.equal(routeModel({ provider: 'opencode', escalate: true }, catalog).selectedModel, 'oc-deep');
  assert.equal(routeModel({ provider: 'opencode', capabilities: ['security'] }, catalog).selectedModel, 'oc-guard');
  assert.equal(routeModel({ provider: 'opencode', security: true }, catalog).inputs.requiredTier, 'security');
  // The reason and host-computed inputs are inspectable evidence.
  const escalated = routeModel({ provider: 'opencode', escalate: true, role: 'decide' }, catalog);
  assert.match(escalated.reason, /escalated/);
  assert.deepEqual(escalated.inputs, { role: 'decide', risk: 'normal', escalate: true, security: false, requiredTier: 'deep', provider: 'opencode' });
});

test('prohibition is metadata-driven, never a model name match', () => {
  const catalog = [
    { id: 'oc-flash', provider: 'opencode', tier: 'routine', cost: 1 },
    { id: 'oc-deep', provider: 'opencode', tier: 'deep', cost: 3 },
    { id: 'vendor/DeepSeek-V4-Pro', provider: 'opencode', tier: 'deep', cost: 0.1, prohibited: true },
  ];
  // The cheapest higher-tier entry is prohibited, so it is never selected.
  assert.equal(routeModel({ provider: 'opencode', risk: 'high' }, catalog).selectedModel, 'oc-deep');
  // A name containing "pro" is irrelevant; eligibility is the only signal.
  const namedPro = [{ id: 'opencode-go/some-pro-model', provider: 'opencode', tier: 'routine', cost: 1 }];
  assert.equal(routeModel({ provider: 'opencode' }, namedPro).selectedModel, 'opencode-go/some-pro-model');
  // A prohibited model can never be reached even when it is the only higher tier.
  assert.throws(() => routeModel({ provider: 'opencode', risk: 'high' }, [routine('routine'), { id: 'only', provider: 'opencode', tier: 'deep', prohibited: true }]), err => err instanceof RoutingError && err.code === 'NO_ELIGIBLE_MODEL');
});

test('routeModel fails closed on an empty, degenerate or unavailable catalog', () => {
  assert.throws(() => routeModel({ provider: 'opencode' }, []), err => err instanceof RoutingError && err.code === 'EMPTY_REGISTRY');
  assert.throws(() => routeModel({ provider: 'opencode' }, [{ id: 'x', provider: 'opencode', tier: 'unknown' }]), err => err instanceof RoutingError && err.code === 'INVALID_REGISTRY');
  assert.throws(() => routeModel({ provider: 'codex' }, [{ id: 'x', provider: 'opencode', tier: 'routine' }]), /No eligible routine-tier model for provider codex/);
  assert.throws(() => routeModel({ provider: 'opencode', unavailable: ['opencode'] }, [{ id: 'x', provider: 'opencode', tier: 'routine' }]), err => err.code === 'NO_ELIGIBLE_MODEL');
});

test('normalizeModelRegistry validates shape once for the runtime', () => {
  const normalized = normalizeModelRegistry([{ id: 'a', provider: 'opencode', tier: 'routine' }]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].eligible, true);
  assert.equal(normalized[0].prohibited, false);
  assert.throws(() => normalizeModelRegistry([{ id: 'a', provider: 'opencode', tier: 'routine' }, { id: 'a', provider: 'opencode', tier: 'deep' }]), /Duplicate/);
});

test('shared quotaGroup makes Codex-backed Pi and Codex one budget, not two', () => {
  const agents = [
    { id: 'codex', provider: 'codex', availability: 'offline', quotaGroup: 'acct' },
    { id: 'pi', provider: 'pi', availability: 'online', quotaGroup: 'acct' },
    { id: 'dsh', provider: 'dsh', availability: 'online' },
  ];
  const unavailable = unavailableAgentIds(agents);
  assert.ok(unavailable.has('codex'));
  assert.ok(unavailable.has('pi'), 'an offline Codex also quarantines its Codex-backed Pi');
  assert.ok(!unavailable.has('dsh'));
  assert.deepEqual(agents.filter(agent => !unavailable.has(agent.id)).map(agent => agent.id), ['dsh']);
  // The reverse direction holds too.
  const reverse = unavailableAgentIds([
    { id: 'codex', provider: 'codex', availability: 'online', quotaGroup: 'acct' },
    { id: 'pi', provider: 'pi', availability: 'offline', quotaGroup: 'acct' },
  ]);
  assert.ok(reverse.has('codex') && reverse.has('pi'));

  const registry = new AgentRegistry();
  for (const agent of agents) registry.add({ ...agent, roles: ['build'], capabilities: ['code'], start() {} });
  assert.equal(registry.select({ role: 'build', capabilities: ['code'] }).id, 'dsh');
  assert.equal(registry.isUnavailable('pi'), true);
});

test('per-call task.model overrides the static default in every native adapter', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-routing-adapters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { role: 'build', workspace: root, artifactDir: root, runKey: randomUUID(), permissions: { write: false }, prompt: 'probe' };
  for (const provider of ['opencode', 'codex', 'pi']) {
    const adapter = createAgentAdapter(provider, { model: 'static-model' });
    const routed = await adapter.prepare({ ...base, model: 'routed-model' });
    const index = routed.args.indexOf('--model');
    assert.ok(index >= 0, `${provider} must receive --model`);
    assert.equal(routed.args[index + 1], 'routed-model', provider);
    const fallback = await adapter.prepare({ ...base });
    assert.equal(fallback.args[fallback.args.indexOf('--model') + 1], 'static-model', `${provider} falls back to config.model`);
  }
  const dsh = createAgentAdapter('dsh', { model: 'static-dsh' });
  let initialize; (await dsh.prepare({ ...base, model: 'routed-dsh' })).begin({ send: message => { initialize = message; } });
  assert.equal(initialize.params.model, 'routed-dsh');
  let fallbackInit; (await dsh.prepare({ ...base })).begin({ send: message => { fallbackInit = message; } });
  assert.equal(fallbackInit.params.model, 'static-dsh');
  let legacyInit; (await createAgentAdapter('dsh').prepare({ ...base })).begin({ send: message => { legacyInit = message; } });
  assert.equal(legacyInit.params.model, 'deepseek-v4-flash', 'unrouted DSH keeps its legacy default');
});

test('decision escalation inputs are host-computed and reach the router', async () => {
  const registry = new AgentRegistry();
  registry.add({ id: 'dsh', identity: 'dsh', provider: 'test-double', availability: 'online', roles: ['decide'], capabilities: ['reason'], trust: 0.8, cost: 1, start() {} });
  const seen = [];
  const router = new ModelDecision(async (agent, task) => { seen.push(task); return { complete: true, reason: 'accepted evidence', gaps: [], candidates: [] }; }, registry);
  const state = { goal: 'g', successCriteria: [], constraints: [], failures: [], actions: [{ phase: 'REJECTED' }, { phase: 'NO_CHANGE' }], agentPerformance: {} };
  await router.assess(state, {}, '.');
  assert.equal(seen[0].escalate, true);
  assert.equal(seen[0].risk, 'high');
});

function routingAgent(id, behavior) {
  return {
    id, identity: `${id}-identity`, provider: 'test-double', availability: 'online',
    roles: ['decide', 'build', 'review'], capabilities: ['reason', 'code', 'review', 'security'], trust: 0.8, cost: 1,
    describe() { return { id, provider: this.provider, roles: this.roles, availability: this.availability }; },
    async start(task) { return { id: randomUUID(), dispose: async () => {}, result: Promise.resolve().then(() => behavior(task)) }; },
  };
}

test('routing evidence is persisted on decisions, actions and runs and exposed in view()', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-routing-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createCheckoutFixture(path.join(root, 'repo'));
  const models = [
    { id: 'td-flash', provider: 'test-double', tier: 'routine', cost: 1 },
    { id: 'td-deep', provider: 'test-double', tier: 'deep', cost: 3 },
    { id: 'td-pro', provider: 'test-double', tier: 'deep', cost: 0.1, prohibited: true },
  ];
  const behavior = async task => {
    if (task.role === 'decide') return { complete: false, reason: 'Fix quantity totals', projectHealth: 0.4, currentState: {}, gaps: [{ id: 'quantity', description: 'Totals ignore quantity', priority: 90, evidence: ['acceptance test'] }], candidates: [{ gapId: 'quantity', goal: 'Fix quantity totals', capabilities: ['code'], risk: 'normal', strategy: 'repair', rationale: 'acceptance test' }] };
    if (task.role === 'build') {
      await writeFile(path.join(task.workspace, 'checkout.mjs'), 'export const total = items => items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);\nexport const delivery = items => total(items) >= 30 ? 0 : 5;\n');
      await writeFile(path.join(task.workspace, 'style.css'), '.checkout { display: block; padding: 16px; }\n');
      return { summary: 'fixed' };
    }
    return { verdict: 'pass', reason: 'checked', evidence: ['source'], blockingRisks: [] };
  };
  const config = { ...fixture, stateDir: path.join(root, 'state'), tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }], protectedPaths: ['tests/acceptance.test.mjs'], models };
  const runtime = new ProjectRuntime(config, { agents: [routingAgent('dsh', behavior), routingAgent('codex', behavior)] });
  await runtime.start({ maxActions: 1 });

  const decision = runtime.state.decisions[0];
  assert.equal(decision.routing.selectedModel, 'td-flash');
  assert.equal(decision.routing.provider, 'test-double');
  assert.equal(typeof decision.routing.reason, 'string');
  assert.equal(typeof decision.routing.at, 'string');
  assert.deepEqual(Object.keys(decision.routing.inputs).sort(), ['escalate', 'provider', 'requiredTier', 'risk', 'role', 'security']);

  const action = runtime.state.actions[0];
  assert.equal(action.phase, 'MERGE_READY');
  assert.equal(action.routing.selectedModel, 'td-flash', 'a routine build uses the routine-tier default');
  assert.notEqual(action.reviews[0].reviewer, action.builder, 'routing never lets the Builder choose its own reviewer');
  const reviewRun = runtime.state.runs.find(run => run.role === 'review');
  assert.equal(reviewRun.routing.provider, 'test-double');
  assert.ok(runtime.state.runs.filter(run => run.routing).every(run => run.routing.selectedModel !== 'td-pro'), 'the prohibited model is never launched');

  const view = runtime.view();
  assert.equal(view.world.decisions[0].routing.selectedModel, 'td-flash');
  assert.equal(view.world.actions[0].routing.selectedModel, 'td-flash');
});

test('autoModelRouting:false preserves static behavior and rejects an ineligible static model', () => {
  const base = { goal: 'g', successCriteria: ['c'], repository: path.join(os.tmpdir(), 'routing-missing-repo'), stateDir: path.join(os.tmpdir(), 'routing-missing-state'), tests: [{ executable: process.execPath, args: ['-e', ''] }] };
  const agent = model => ({ id: 'dsh', identity: 'dsh', provider: 'test-double', model, roles: ['build', 'decide', 'review'], capabilities: ['reason', 'code', 'review'], availability: 'online', start() {} });
  const models = [{ id: 'td-flash', provider: 'test-double', tier: 'routine' }, { id: 'td-pro', provider: 'test-double', tier: 'deep', prohibited: true }];
  assert.throws(() => new ProjectRuntime({ ...base, autoModelRouting: false, models }, { agents: [agent('td-pro')] }), err => err instanceof RoutingError && err.code === 'INELIGIBLE_STATIC_MODEL');
  const runtime = new ProjectRuntime({ ...base, autoModelRouting: false, models }, { agents: [agent('td-flash')] });
  assert.equal(runtime.routeFor(agent('td-flash'), { role: 'build' }), undefined);
});
