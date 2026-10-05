import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleNewProjectReport } from '../scripts/new-project-report.mjs';

// Deterministic coverage for the native new-project verdict assembly and its
// error path. These tests launch no provider and touch no repository; they lock
// the fail-closed contract that a thrown start/read or a non-OpenCode handoff
// can never produce a PASS.

function passingState(overrides = {}) {
  return {
    status: 'complete',
    alignments: [],
    actions: [{
      id: 'action-1',
      goal: 'Implement the described product',
      phase: 'MERGE_READY',
      builder: 'opencode',
      protectedIntact: true,
      commit: 'commit-1',
      tests: [{ passed: true }],
      committedTests: [{ passed: true }],
      reviews: [{ reviewer: 'pi', verdict: 'pass', blockingRisks: [] }],
      ...overrides,
    }],
  };
}

function assemble(state, extra = {}) {
  return assembleNewProjectReport({
    state,
    precheck: { status: 1, signal: null, error: null },
    initialHead: 'head-0',
    mainHead: 'head-0',
    restartState: state,
    testCount: 1,
    stateFile: 'state/world.json',
    ...extra,
  });
}

test('a fully accepted fresh run assembles a PASS verdict', () => {
  const { status, checks } = assemble(passingState());
  assert.equal(status, 'PASS');
  assert.ok(Object.values(checks).every(Boolean));
});

test('a non-OpenCode final implementer is a distinct non-PASS check', () => {
  // Under the previous `includes("opencode")` expression this candidate yielded
  // true, allowing a quota handoff to satisfy the native-OpenCode claim.
  const state = passingState({ builder: 'pi', builderHistory: ['opencode', 'pi'] });
  const { status, checks } = assemble(state);
  assert.equal(checks.opencodeBuilder, false);
  assert.equal(checks.builderHandoffFree, false);
  assert.equal(status, 'FAIL');
});

test('an OpenCode final builder after a handoff still fails the handoff check', () => {
  const state = passingState({ builder: 'opencode', builderHistory: ['pi', 'opencode'] });
  const { status, checks } = assemble(state);
  assert.equal(checks.opencodeBuilder, true);
  assert.equal(checks.builderHandoffFree, false);
  assert.equal(status, 'FAIL');
});

test('no MERGE_READY candidate fails closed', () => {
  const { status, checks } = assemble({ status: 'budget-exhausted', actions: [], alignments: [] });
  assert.equal(checks.mergeReadyCandidate, false);
  assert.equal(checks.opencodeBuilder, false);
  assert.equal(status, 'FAIL');
});

test('a thrown runtime.start() forces FAIL and is recorded', () => {
  const { status, checks, report } = assemble(passingState(), { error: 'runtime start exploded' });
  assert.equal(checks.runtimeErrorFree, false);
  assert.equal(status, 'FAIL');
  assert.equal(report.error, 'runtime start exploded');
});

test('a thrown git read forces FAIL and still returns a report', () => {
  const { status, checks, report } = assemble(passingState(), { mainHead: undefined, mainHeadError: 'git rev-parse failed' });
  assert.equal(checks.mainUntouched, false);
  assert.equal(status, 'FAIL');
  assert.equal(report.readErrors.mainHead, 'git rev-parse failed');
  assert.equal(report.status, 'FAIL');
});

test('a thrown store read forces FAIL and still returns a report', () => {
  const { status, checks, report } = assemble(passingState(), { restartState: undefined, restartStateError: 'world.json malformed' });
  assert.equal(checks.restartState, false);
  assert.equal(status, 'FAIL');
  assert.equal(report.readErrors.restartState, 'world.json malformed');
});

test('a missing state assembles a FAIL report without throwing', () => {
  const { status, report } = assemble(undefined);
  assert.equal(status, 'FAIL');
  assert.equal(report.stateStatus, 'not-initialized');
  assert.deepEqual(report.actions, []);
});

test('a signal-terminated precheck with null status cannot satisfy the gate', () => {
  // spawnSync reports status null and a non-null signal for a killed child. The
  // previous `status !== 0` expression treated null as a clean failure and let the
  // verdict proceed toward a false PASS despite a crashed precheck.
  const { status, checks, report } = assemble(passingState(), { precheck: { status: null, signal: 'SIGTERM', error: null } });
  assert.equal(checks.hostPrecheckFailsOnBrief, false);
  assert.equal(status, 'FAIL');
  assert.equal(report.hostPrecheck.signal, 'SIGTERM');
  assert.equal(report.hostPrecheck.status, null);
});

test('an undefined precheck status cannot satisfy the gate', () => {
  const { status, checks } = assemble(passingState(), { precheck: { status: undefined, signal: null, error: null } });
  assert.equal(checks.hostPrecheckFailsOnBrief, false);
  assert.equal(status, 'FAIL');
});

test('a precheck spawn error cannot satisfy the gate', () => {
  const { status, checks, report } = assemble(passingState(), { precheck: { status: null, signal: null, error: 'spawn failed' } });
  assert.equal(checks.hostPrecheckFailsOnBrief, false);
  assert.equal(status, 'FAIL');
  assert.equal(report.hostPrecheck.error, 'spawn failed');
});

test('a pre-passing precheck (clean exit zero) cannot satisfy the gate', () => {
  const { status, checks } = assemble(passingState(), { precheck: { status: 0, signal: null, error: null } });
  assert.equal(checks.hostPrecheckFailsOnBrief, false);
  assert.equal(status, 'FAIL');
});
