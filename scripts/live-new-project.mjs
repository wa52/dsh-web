import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as control from '../plugins/autonomous-control-loop/index.js';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { atomicJson } from '../runtime/store.mjs';
import { createBriefFixture, newProjectConfig } from './fixture.mjs';

if (!process.argv[2]) throw new Error('Live new-project acceptance uses real configured models: node scripts/live-new-project.mjs config.local.json [dir]');
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve('.tmp', `live-new-project-${randomUUID()}`);
const repository = path.join(root, 'repo');
if (existsSync(repository)) throw new Error(`Refusing to reuse an existing product directory: ${repository}. Choose a new output directory for a fresh acceptance run.`);
await mkdir(root, { recursive: true });

// The goal requires native OpenCode as the builder plus an independent, non-Codex
// reviewer. Codex is intentionally never registered (quota availability is not assumed).
const providerIds = Object.keys(options.agents ?? {});
if (!providerIds.includes('opencode')) throw new Error('The native new-project builder must be configured as "opencode"');
const reviewers = providerIds.filter(provider => provider !== 'opencode' && provider !== 'codex');
if (!reviewers.length) throw new Error('An independent non-Codex reviewer (pi or dsh) is required');

const fixture = await createBriefFixture(repository);
const acceptance = fileURLToPath(new URL('./new-project-acceptance.mjs', import.meta.url));

// Host precheck: prove the external acceptance is real by failing it against the
// bare brief before any Builder runs. A pre-passing acceptance proves nothing.
// NODE_TEST_CONTEXT is removed to match runtime/process.mjs Host-command launching.
const precheckEnv = { ...process.env };
delete precheckEnv.NODE_TEST_CONTEXT;
const precheck = spawnSync(process.execPath, [acceptance], { cwd: repository, encoding: 'utf8', windowsHide: true, env: precheckEnv });
// A genuine acceptance failure is a non-zero exit without a spawn error; a
// spawn error means the precheck itself did not run and must not count as proof.
const precheckFailedOnBrief = precheck.status !== 0 && !precheck.error;

const config = newProjectConfig(fixture, { root, acceptance, options });
const initialHead = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const agents = ['opencode', ...reviewers].map(provider => createAgentAdapter(provider, options.agents[provider]));
const ctx = new Context();
const fiber = ctx.plugin(control);
await new Promise(resolve => setImmediate(resolve));
const runtime = ctx.autonomousControl.createProject(config, { agents });
runtime.on('state', view => console.log(`${view.world.phase} ${view.world.actions.at(-1)?.goal ?? ''}`));
let state, error;
try { state = await runtime.start(); } catch (failure) { error = failure.message; state = runtime.state; }
await fiber.dispose();
// An early initialization failure (for example a repository that is not a Git
// root) leaves no world state. Report FAIL honestly instead of crashing here.
state ??= { status: 'not-initialized', actions: [], alignments: [] };

const mergeReady = state.actions.filter(action => action.phase === 'MERGE_READY');
const candidate = mergeReady.at(-1);
const tests = candidate?.tests ?? [];
const committedTests = candidate?.committedTests ?? [];
const reviews = candidate?.reviews ?? [];
const mainHead = await runtime.worktrees.git(config.repository, ['rev-parse', 'HEAD']);
const checks = {
  hostPrecheckFailsOnBrief: precheckFailedOnBrief,
  mergeReadyCandidate: mergeReady.length >= 1,
  builderTestsPassed: tests.length === config.tests.length && tests.every(test => test.passed),
  committedTestsPassed: committedTests.length === config.tests.length && committedTests.every(test => test.passed),
  opencodeBuilder: Boolean(candidate) && [candidate.builder, ...(candidate.builderHistory ?? [])].includes('opencode'),
  independentReview: reviews.length > 0 && reviews.every(review => review.reviewer !== candidate.builder && review.verdict === 'pass' && (review.blockingRisks ?? []).length === 0),
  briefProtected: candidate?.protectedIntact === true,
  mainUntouched: mainHead === initialHead,
  restartState: JSON.stringify(await runtime.store.load()) === JSON.stringify(state),
};
const completion = (state.alignments ?? []).filter(alignment => alignment.stage === 'commercial-completion').at(-1);
const completionAudit = completion
  ? { outcome: completion.audit.outcome, reason: completion.audit.reason, reviewer: completion.audit.reviewer }
  : { outcome: 'not-reached', reason: 'The decision model did not declare scoped completion; this is reported separately and does not change the bounded MERGE_READY acceptance.' };
const report = {
  at: new Date().toISOString(),
  scenario: 'Native new-project acceptance: brief-only repository, native OpenCode builder, independent non-Codex reviewer, external Host acceptance and mandatory review gates',
  native: true,
  scriptedDecision: false,
  suppliedTodoOrder: false,
  passDefinition: 'PASS means a candidate reached MERGE_READY with builder-tree and clean-committed-tree external Host acceptance passing and an independent non-Codex review, main unchanged and restart state equal. It is not the same as state.status === "complete" and is not a commercial-readiness claim.',
  status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
  checks,
  stateStatus: state.status,
  completionAudit,
  hostPrecheck: { status: precheck.status, signal: precheck.signal, error: precheck.error?.message ?? null },
  error,
  stateFile: runtime.store.file,
  actions: state.actions.map(action => ({ id: action.id, goal: action.goal, phase: action.phase, builder: action.builder, builderHistory: action.builderHistory, commit: action.commit, protectedIntact: action.protectedIntact, reviews: action.reviews.map(review => ({ reviewer: review.reviewer, verdict: review.verdict })) })),
};
await atomicJson(path.join(root, 'acceptance.json'), report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
