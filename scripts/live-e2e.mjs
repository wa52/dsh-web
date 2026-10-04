import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import * as control from '../plugins/autonomous-control-loop/index.js';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { atomicJson } from '../runtime/store.mjs';
import { createCheckoutFixture } from './fixture.mjs';

if (!process.argv[2]) throw new Error('Live E2E uses real configured models: npm run test:live -- config.local.json');
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve('.tmp', `live-e2e-${randomUUID()}`);
await mkdir(root, { recursive: true });
const prior = process.argv[3] ? JSON.parse(await readFile(path.join(root, 'state/world.json'), 'utf8')) : null;
const fixture = prior ? { repository: prior.project.repository, goal: prior.goal, successCriteria: prior.successCriteria } : await createCheckoutFixture(path.join(root, 'repo'));
const config = { ...fixture, stateDir: path.join(root, 'state'), constraints: ['Never edit acceptance tests', 'Keep main untouched'], permissions: options.permissions ?? { shell: false, network: false },
  protectedPaths: ['tests/acceptance.test.mjs'], tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }], decisionAgent: options.decisionAgent ?? 'codex', maxActions: options.maxActions ?? 8, agentTimeoutMs: options.agentTimeoutMs ?? 180_000 };
const agents = Object.entries(options.agents).map(([provider, settings]) => createAgentAdapter(provider, settings));
const ctx = new Context(); const fiber = ctx.plugin(control);
await new Promise(resolve => setImmediate(resolve));
let injected = prior?.evidence?.some(e => e.kind === 'environment-event' && e.scenario === 'delivery-regression') ?? false;
const runtime = ctx.autonomousControl.createProject(config, { agents, afterBuild: async (action, directory) => {
  // Adversarial fixture event, not a scripted review verdict or task sequence.
  // A correct Builder may fix all seed defects at once; still test a real regression gate.
  if (injected) return;
  const target = path.join(directory, 'checkout.mjs');
  const source = await readFile(target, 'utf8');
  if (!/item\.quantity|quantity\s*\?\?/.test(source)) return;
  const changed = source.replace(/export const delivery\s*=[\s\S]*$/, 'export const delivery = items => items.reduce((sum, item) => sum + item.price, 0) >= 30 ? 0 : 5;\n');
  if (changed === source) return;
  await writeFile(target, changed);
  injected = true;
  return { scenario: 'delivery-regression', reason: 'Controlled fault injection after Builder stop; actual acceptance test and independent reviewer must catch it' };
} });
runtime.on('state', view => console.log(`${view.world.phase} ${view.world.actions.at(-1)?.goal ?? ''}`));
let state, error;
try { state = await runtime.start(); } catch (failure) { error = failure.message; state = runtime.state; }
await fiber.dispose();
const providers = new Set(state.runs.map(run => agents.find(agent => agent.id === run.worker)?.provider));
const checks = {
  complete: state.status === 'complete',
  twoProviders: providers.size >= 2,
  mandatoryReview: state.actions.some(action => action.reviews.length > 0),
  rejectedThenReplanned: state.actions.some(action => action.phase === 'REJECTED') && state.decisions.length > 1,
  tracedCommits: state.actions.some(action => action.phase === 'MERGE_READY') && state.actions.filter(action => action.phase === 'MERGE_READY').every(action => action.commit && action.tests.every(test => test.passed) && action.reviews.length),
  mainUntouched: (await runtime.worktrees.git(config.repository, ['rev-parse', 'HEAD'])) === state.evidence.find(e => e.kind === 'observation')?.head,
  restartState: JSON.stringify(await runtime.store.load()) === JSON.stringify(state),
};
const report = { at: new Date().toISOString(), scenario: 'Live models with a one-time delivery fault injected after Builder stop; no scripted decisions or review verdicts', status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', checks, error, stateFile: runtime.store.file, actions: state.actions.map(action => ({ id: action.id, goal: action.goal, phase: action.phase, builder: action.builder, commit: action.commit, reviews: action.reviews.map(review => ({ reviewer: review.reviewer, verdict: review.verdict })) })) };
await atomicJson(path.join(root, 'acceptance.json'), report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
