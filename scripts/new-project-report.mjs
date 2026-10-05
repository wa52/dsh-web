// Pure, additive assembly of the native new-project acceptance verdict. Kept
// separate from scripts/live-new-project.mjs so the verdict and its error path
// can be exercised deterministically without launching real providers.
//
// Fail-closed contract: the status is exactly `every(check) === true`. A thrown
// runtime.start() or a thrown store/git read always yields FAIL; no catch branch
// in the runner may ever set PASS.

const SCENARIO = 'Native new-project acceptance: brief-only repository, native OpenCode builder, independent non-Codex reviewer, external Host acceptance and mandatory review gates';
const PASS_DEFINITION = 'PASS means a candidate reached MERGE_READY with builder-tree and clean-committed-tree external Host acceptance passing, a native OpenCode builder, no quota handoff, an independent non-Codex review, main unchanged and restart state equal. It is not the same as state.status === "complete" and is not a commercial-readiness claim.';

const notInitialized = () => ({ status: 'not-initialized', actions: [], alignments: [] });

export function assembleNewProjectReport({
  state,
  precheck = {},
  initialHead,
  mainHead,
  mainHeadError = null,
  restartState,
  restartStateError = null,
  stateFile,
  testCount,
  error = null,
  at = new Date().toISOString(),
}) {
  const world = state ?? notInitialized();
  const actions = world.actions ?? [];
  const mergeReady = actions.filter(action => action.phase === 'MERGE_READY');
  const candidate = mergeReady.at(-1);
  const tests = candidate?.tests ?? [];
  const committedTests = candidate?.committedTests ?? [];
  const reviews = candidate?.reviews ?? [];

  const checks = {
    hostPrecheckFailsOnBrief: precheck.status !== 0 && !precheck.error,
    mergeReadyCandidate: mergeReady.length >= 1,
    builderTestsPassed: tests.length === testCount && tests.every(test => test.passed),
    committedTestsPassed: committedTests.length === testCount && committedTests.every(test => test.passed),
    // The finally accepted candidate must itself have been implemented by native
    // OpenCode; a previous contributor is not sufficient.
    opencodeBuilder: candidate?.builder === 'opencode',
    // project.mjs appends builderHistory only on a quota handoff, so more than one
    // entry means another provider contributed to the accepted implementation.
    builderHandoffFree: !(candidate?.builderHistory?.length > 1),
    independentReview: reviews.length > 0 && reviews.every(review => review.reviewer !== candidate.builder && review.verdict === 'pass' && (review.blockingRisks ?? []).length === 0),
    briefProtected: candidate?.protectedIntact === true,
    mainUntouched: !mainHeadError && mainHead === initialHead,
    restartState: !restartStateError && JSON.stringify(restartState) === JSON.stringify(world),
    runtimeErrorFree: !error,
  };

  const completion = (world.alignments ?? []).filter(alignment => alignment.stage === 'commercial-completion').at(-1);
  const completionAudit = completion
    ? { outcome: completion.audit.outcome, reason: completion.audit.reason, reviewer: completion.audit.reviewer }
    : { outcome: 'not-reached', reason: 'The decision model did not declare scoped completion; this is reported separately and does not change the bounded MERGE_READY acceptance.' };

  const report = {
    at,
    scenario: SCENARIO,
    native: true,
    scriptedDecision: false,
    suppliedTodoOrder: false,
    passDefinition: PASS_DEFINITION,
    status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    stateStatus: world.status,
    completionAudit,
    hostPrecheck: { status: precheck.status ?? null, signal: precheck.signal ?? null, error: precheck.error ?? null },
    error: error ?? null,
    readErrors: mainHeadError || restartStateError ? { mainHead: mainHeadError ?? null, restartState: restartStateError ?? null } : undefined,
    stateFile,
    actions: actions.map(action => ({ id: action.id, goal: action.goal, phase: action.phase, builder: action.builder, builderHistory: action.builderHistory, commit: action.commit, protectedIntact: action.protectedIntact, reviews: (action.reviews ?? []).map(review => ({ reviewer: review.reviewer, verdict: review.verdict })) })),
  };

  return { status: report.status, checks, report };
}
