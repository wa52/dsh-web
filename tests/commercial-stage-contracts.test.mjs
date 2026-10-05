import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';
import { stageAuditContract, PRE_DEVELOPMENT_STAGES, FINAL_GATE_STAGES } from '../runtime/commercial.mjs';

// Additive deterministic coverage for the stage-scoped alignment contract and for
// retention of the final candidate gates. Test-double agents and an injectable
// fetch seam keep these free of real network. No pre-existing test is edited.

async function fixture(t, { fetchBenchmark, decideText, references, reviewerOutcome = 'PASS', reviewerReason = 'Stage evidence checked', research } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-stage-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await createCheckoutFixture(path.join(root, 'repo'));
  const notes = decideText ?? '# Reference fit\nNo verified benchmark available yet.';
  const workerPrompts = [];
  const reviewerPrompts = [];
  const agent = id => ({
    id, identity: id, provider: 'test-double', availability: 'online',
    roles: ['build', 'decide', 'review'], capabilities: ['reason', 'code', 'review', 'security'], trust: 0.8, cost: 1,
    describe() { return { id, roles: this.roles, availability: this.availability }; },
    async start(task) {
      return { id: `${id}-${Date.now()}`, result: Promise.resolve().then(() => {
        if (task.outputFormat === 'text') { workerPrompts.push(task.prompt); return { text: notes }; }
        if (task.outputSchema?.outcome) {
          reviewerPrompts.push(task.prompt);
          return { outcome: reviewerOutcome, reason: reviewerReason, evidence: ['stage analysis and supplied evidence'], blockers: reviewerOutcome === 'PASS' ? [] : ['unresolved stage blocker'] };
        }
        return { verdict: 'pass', reason: 'candidate checked', evidence: ['source'], blockingRisks: [] };
      }), dispose: async () => {} };
    },
  });
  const refs = references ?? [{ url: 'https://example.com/seed', title: 'Seed reference' }];
  const config = { ...f, stateDir: path.join(root, 'state'), tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }], protectedPaths: ['tests/acceptance.test.mjs'], commercialLoop: { enabled: true, worker: 'opencode', fetchReferences: true, maxAlignmentAttempts: 2, references: refs } };
  const runtime = new ProjectRuntime(config, { agents: [agent('opencode'), agent('pi'), agent('dsh')], research });
  await runtime.initialize();
  if (fetchBenchmark) runtime.commercial.fetchBenchmark = fetchBenchmark;
  return { runtime, root, config, workerPrompts, reviewerPrompts, notes };
}

const oversized = () => Object.assign(new Error('Benchmark document exceeds 512KB budget'), { reason: 'oversized' });

test('stage audit contract is scoped per stage and preserves the final gates', () => {
  assert.deepEqual([...PRE_DEVELOPMENT_STAGES], ['observe-and-prioritize', 'plan', 'execution-route']);
  assert.deepEqual([...FINAL_GATE_STAGES], ['verify', 'commercial-completion']);
  for (const stage of PRE_DEVELOPMENT_STAGES) {
    const contract = stageAuditContract(stage);
    assert.match(contract, new RegExp(`pre-development stage \\(${stage}\\)`));
    assert.match(contract, /do not require an already-retrieved mature product benchmark/i);
    assert.match(contract, /functional\/UI\/regression/);
    assert.match(contract, /research debt deferred to verify/);
  }
  assert.match(stageAuditContract('verify'), /missing functional\/UI\/regression evidence must not pass/);
  assert.match(stageAuditContract('commercial-completion'), /all scoped criteria have current evidence/);
  assert.throws(() => stageAuditContract('unknown-stage'), /Unknown alignment stage/);
});

test('reviewer prompt carries the per-stage contract for every stage', async t => {
  const { runtime, config, reviewerPrompts } = await fixture(t, { references: [{ url: 'https://example.com/ref', title: 'Verified reference', text: 'Verified reference text describing a mature workspace with roles and reports.' }] });
  for (const stage of PRE_DEVELOPMENT_STAGES) await runtime.alignment(stage, {}, { directory: config.repository }, undefined, false);
  await runtime.alignment('verify', {}, { directory: config.repository }, { id: 'action-1' }, false);
  await runtime.alignment('commercial-completion', {}, { directory: config.repository }, undefined, false);
  assert.equal(reviewerPrompts.length, PRE_DEVELOPMENT_STAGES.length + 2);
  for (const stage of PRE_DEVELOPMENT_STAGES) assert.ok(reviewerPrompts.some(prompt => prompt.includes(`pre-development stage (${stage})`)), `prompt carries the ${stage} contract`);
  assert.ok(reviewerPrompts.some(prompt => prompt.includes('missing functional/UI/regression evidence must not pass')));
  assert.ok(reviewerPrompts.some(prompt => prompt.includes('all scoped criteria have current evidence')));
  assert.ok(reviewerPrompts.every(prompt => prompt.includes('must never override Host tests, protected files')));
});

test('a pre-development plan with no candidate and a reviewer PASS records research debt instead of forcing NEED_RESEARCH', async t => {
  const { runtime, config } = await fixture(t, { fetchBenchmark: async () => { throw oversized(); }, decideText: '# Analysis\nThe seed is oversized and no replacement is available yet. Proceed with the foundation and verify the benchmark later.\n' });
  const record = await runtime.alignment('plan', {}, { directory: config.repository });
  assert.equal(record.audit.outcome, 'PASS');
  assert.equal(record.researchDebt.reason, 'no-candidates-proposed');
  assert.equal(record.researchDebt.stage, 'plan');
  assert.equal(record.researchDebt.deferredTo, 'verify');
  assert.ok(record.sources.some(source => source.reason === 'no-candidates-proposed'));
  assert.ok(record.sources.every(source => source.verified === false));
  const persisted = (await runtime.store.load()).alignments.at(-1);
  assert.equal(persisted.audit.outcome, 'PASS');
  assert.equal(persisted.researchDebt.reason, 'no-candidates-proposed');
});

test('a pre-development plan with every proposed candidate failed still rejects and records no debt', async t => {
  const fetcher = async ref => { throw Object.assign(new Error(ref.url === 'https://example.com/seed' ? 'Benchmark document exceeds 512KB budget' : 'Benchmark HTTP 404; redirects are not followed'), { reason: ref.url === 'https://example.com/seed' ? 'oversized' : 'http-404' }); };
  const decideText = '# Analysis\nPropose a bounded alternative:\n```proposed-references\nhttps://example.com/candidate\n```\n';
  const { runtime, config } = await fixture(t, { fetchBenchmark: fetcher, decideText });
  await assert.rejects(runtime.alignment('plan', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
  const record = (await runtime.store.load()).alignments.at(-1);
  assert.ok(record.sources.some(source => source.reason === 'all-candidates-failed'));
  assert.equal(record.researchDebt, undefined);
});

test('an injected Host researcher failure stays hard at a pre-development stage', async t => {
  const { runtime, config } = await fixture(t, { references: [] });
  runtime.commercial.research = async () => ({ text: 'Unsupported claim without a source URL' });
  await assert.rejects(runtime.alignment('plan', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
  const record = (await runtime.store.load()).alignments.at(-1);
  assert.equal(record.researchDebt, undefined);
});

test('verify and commercial-completion retain the verified-source gate when pre-development research debt is allowed', async t => {
  const { runtime, config } = await fixture(t, { fetchBenchmark: async () => { throw oversized(); }, decideText: '# Analysis\nThe seed is oversized; no replacement candidate. The benchmark is deferred.\n' });
  // The exact no-candidate/no-verified condition that is deferred at a pre-dev stage...
  const plan = await runtime.alignment('plan', {}, { directory: config.repository }, undefined, false);
  assert.equal(plan.audit.outcome, 'PASS');
  assert.equal(plan.researchDebt.reason, 'no-candidates-proposed');
  // ...must still fail the final gates unconditionally.
  const verify = await runtime.alignment('verify', {}, { directory: config.repository }, { id: 'action-1' }, false);
  assert.equal(verify.audit.outcome, 'NEED_RESEARCH');
  assert.equal(verify.researchDebt, undefined);
  await assert.rejects(runtime.alignment('commercial-completion', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
});

test('a plan PASS with scope-changing advice does not change the reviewed proposed action', async t => {
  const { runtime, config } = await fixture(t, {
    references: [{ url: 'https://example.com/ref', title: 'Verified reference', text: 'Mature workspace reference text.' }],
    reviewerReason: 'PASS for the reviewed route; a later slice may add a customers vertical, but the reviewed proposed action remains the runtime foundation.',
  });
  let reviewedPlanObservation;
  const originalStage = runtime.commercial.stage.bind(runtime.commercial);
  runtime.commercial.stage = async (stage, observation, tree, action, retry) => {
    if (stage === 'plan') reviewedPlanObservation = observation;
    return originalStage(stage, observation, tree, action, retry);
  };
  runtime.assessment = async () => ({ complete: false, reason: 'Foundational gap', currentState: {}, projectHealth: 0.1, gaps: [{ id: 'gap-runtime', description: 'The runtime entry does not exist', priority: 96, evidence: ['host acceptance fails at startup'] }], candidates: [{ gapId: 'gap-runtime', goal: 'Create the runtime foundation', capabilities: ['code'], risk: 'normal', strategy: 'repair' }] });
  const snapshot = await runtime.worktrees.snapshot(config.repository);
  const selected = await runtime.decide({ head: runtime.state.acceptedHead, acceptedHead: runtime.state.acceptedHead, snapshot, tests: [{ passed: true }] }, { directory: config.repository });
  assert.equal(selected.candidate.goal, 'Create the runtime foundation');
  assert.equal(reviewedPlanObservation.proposedAction, selected.candidate, 'The dispatched action is exactly the action the plan audit reviewed');
  assert.equal(runtime.state.decisions.at(-1).selected, selected.candidate);
});

test('a NEED_RESEARCH retry is evidence-changing and solicits untried candidate URLs', async t => {
  let fetchCalls = 0;
  const fetcher = async ref => { fetchCalls++; throw Object.assign(new Error(ref.url === 'https://example.com/seed' ? 'Benchmark document exceeds 512KB budget' : 'Benchmark HTTP 404; redirects are not followed'), { reason: ref.url === 'https://example.com/seed' ? 'oversized' : 'http-404' }); };
  const decideText = '# Analysis\nPropose a bounded alternative:\n```proposed-references\nhttps://example.com/candidate\n```\n';
  const { runtime, config, workerPrompts } = await fixture(t, { fetchBenchmark: fetcher, decideText });
  await assert.rejects(runtime.alignment('plan', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
  assert.equal(workerPrompts.length, 2, 'One worker call per bounded attempt');
  assert.doesNotMatch(workerPrompts[0], /This is retry/);
  assert.match(workerPrompts[1], /This is retry 1 after a NEED_RESEARCH audit\./);
  assert.match(workerPrompts[1], /already retrieved and failed/);
  assert.match(workerPrompts[1], /https:\/\/example\.com\/seed/);
  assert.match(workerPrompts[1], /https:\/\/example\.com\/candidate/);
  assert.match(workerPrompts[1], /Propose NEW, untried/);
  assert.equal(fetchCalls, 2, 'The retry seeks new evidence without re-fetching the cached failed sources');
});
