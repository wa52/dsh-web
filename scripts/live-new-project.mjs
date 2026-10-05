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
import { assembleNewProjectReport } from './new-project-report.mjs';

if (!process.argv[2]) throw new Error('Live new-project acceptance uses real configured models: node scripts/live-new-project.mjs config.local.json [dir]');
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve('.tmp', `live-new-project-${randomUUID()}`);
const repository = path.join(root, 'repo');
const stateDir = path.join(root, 'state');
// A fresh, isolated run is required. Refuse an existing output root or state
// directory so a stale world.json with prior MERGE_READY evidence can never be
// reused when the repository directory happens to be absent.
if (existsSync(root) || existsSync(repository) || existsSync(stateDir)) throw new Error(`Refusing to reuse an existing output directory: ${root}. Choose a new output directory for a fresh acceptance run.`);
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
const precheckResult = { status: precheck.status, signal: precheck.signal, error: precheck.error?.message ?? null };

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

// Post-run reads are wrapped so a thrown store/git read cannot abort before the
// report is written; the failure is recorded and the affected checks go false.
let mainHead, mainHeadError = null;
try { mainHead = await runtime.worktrees.git(config.repository, ['rev-parse', 'HEAD']); }
catch (failure) { mainHeadError = failure.message; }

let restartState, restartStateError = null;
try { restartState = await runtime.store.load(); }
catch (failure) { restartStateError = failure.message; }

const { report } = assembleNewProjectReport({
  state,
  precheck: precheckResult,
  initialHead,
  mainHead,
  mainHeadError,
  restartState,
  restartStateError,
  stateFile: runtime.store.file,
  testCount: config.tests.length,
  error,
});
// Always write the report, on both the success and failure paths.
await atomicJson(path.join(root, 'acceptance.json'), report);
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
