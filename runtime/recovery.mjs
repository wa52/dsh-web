import { readFile, unlink, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processFingerprint, stopRecordedRun, findLaunchProcesses, runCommand } from './process.mjs';
import { WorldStore, atomicJson } from './store.mjs';
import { WorktreeManager, hash } from './worktrees.mjs';
import { createAgentAdapter } from './adapters.mjs';
import { REVIEW_SHAPE } from './decision.mjs';

/** Recovery is host-owned: stop verified processes before reopening a crashed project. */
export async function recoverInterruptedProject(config) {
  const store = new WorldStore(config.stateDir);
  await mkdir(store.directory, { recursive: true });
  const recoveryFile = path.join(store.directory, 'recovery.lock');
  const recoveryLock = await open(recoveryFile, 'wx');
  try {
  const lockPath = path.join(store.directory, 'runtime.lock');
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const live = await processFingerprint(lock.pid);
    if (live && (!lock.fingerprint || live === lock.fingerprint)) throw new Error('Controller process still exists; refusing to steal lock');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = await store.load();
  if (!state) throw new Error('No project state to recover');
  for (const run of state.runs.filter(run => !run.stoppedAt)) {
    if (run.pid) await stopRecordedRun(run);
    else if (run.launchToken) for (const record of await findLaunchProcesses(run.launchToken)) await stopRecordedRun(record);
    run.status = 'interrupted'; run.stoppedAt = new Date().toISOString();
  }
  const action = state.actions.at(-1);
  if (action && ['BUILDING', 'HALTED'].includes(action.phase)) {
    action.phase = 'FAILED'; action.error = 'Interrupted Worker stopped by recovery';
    state.failures.push({ actionId: action.id, error: action.error, at: new Date().toISOString() });
  }
  state.status = 'paused'; state.phase = 'STOP';
  state.events.push({ seq: state.events.length + 1, phase: 'STOP', recovery: 'verified-process-stop', at: new Date().toISOString() });
  await store.save(state);
  try { await unlink(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return state;
  } finally { await recoveryLock.close(); await unlink(recoveryFile); }
}

/** Minimal fallback independent of Cordis, DSH boot and the project Control Loop. */
export async function repairHarness(config) {
  if (!config.recovery?.enabled || !config.recovery.codex || !config.recovery.tests?.length) throw new Error('Explicit recovery Codex and host tests required');
  const recovery = config.recovery;
  const manager = new WorktreeManager(path.resolve(recovery.repository), path.join(path.resolve(config.stateDir), 'recovery-worktrees'), 'harness-recovery');
  await manager.validate();
  const id = randomUUID();
  const base = await manager.git(manager.repository, ['rev-parse', 'HEAD']);
  const tree = await manager.create(id, 'recovery', base);
  const protectedPaths = recovery.protectedPaths ?? [];
  const protectedBefore = await manager.protectedHashes(tree.directory, protectedPaths);
  const artifactDir = path.join(path.resolve(config.stateDir), 'evidence', `recovery-${id}`);
  const codex = createAgentAdapter('codex', { ...recovery.codex, id: 'standalone-recovery' });
  const sources = {};
  for (const file of (await manager.snapshot(tree.directory)).evidence.files) {
    if (file.type === 'file' && /\.(?:[cm]?js|ts|json|py)$/.test(file.name) && !/lock|auth|secret|credential/i.test(file.name)) sources[file.name] = (await readFile(path.join(tree.directory, file.name), 'utf8')).slice(0, 32_000);
  }
  const run = await codex.start({ role: 'recovery', workspace: tree.directory, runKey: id, artifactDir, timeoutMs: recovery.timeoutMs ?? 300_000, permissions: { read: true, write: true, shell: false, network: false },
    prompt: `Repair only the Harness startup/health failure: ${config.failure ?? 'Harness exited unexpectedly'}. Do not schedule project work, commit, merge or push. Do not modify protected files: ${JSON.stringify(protectedPaths)}. Source evidence: ${JSON.stringify(sources)}. Return JSON {"summary":"..."}.` });
  let result;
  try { result = await run.result; } finally { await run.dispose(); }
  const tests = [];
  for (let index = 0; index < recovery.tests.length; index++) tests.push(await runCommand(recovery.tests[index], tree.directory, { artifactDir, name: `recovery-test-${index}` }));
  const commit = await manager.commit(tree, `Repair Harness after failure ${id}`);
  const builderSnapshot = await manager.snapshot(tree.directory);
  const protectedIntact = hash(protectedBefore) === hash(await manager.protectedHashes(tree.directory, protectedPaths));
  const reviewerTree = await manager.create(randomUUID(), 'review', commit);
  const snapshot = await manager.snapshot(reviewerTree.directory);
  const reviewer = createAgentAdapter('codex', { ...recovery.codex, id: 'standalone-recovery-reviewer' });
  const reviewRun = await reviewer.start({ role: 'review', workspace: reviewerTree.directory, runKey: randomUUID(), artifactDir, outputSchema: REVIEW_SHAPE,
    prompt: `Independently review Harness recovery commit ${commit}. Tests: ${JSON.stringify(tests)}. Diff: ${await manager.diff(tree)}. Reject any remaining startup failure or blocking risk.`, permissions: { write: false } });
  let report;
  try { report = await reviewRun.result; } finally { await reviewRun.dispose(); }
  const passed = protectedIntact && tests.every(test => test.passed) && report.verdict === 'pass' && Array.isArray(report.evidence) && report.evidence.length > 0 && Array.isArray(report.blockingRisks) && report.blockingRisks.length === 0 && (await manager.snapshot(reviewerTree.directory)).hash === snapshot.hash && (await manager.snapshot(tree.directory)).hash === builderSnapshot.hash;
  const evidence = { id, base, commit, tree, tests, result, review: report, protectedIntact, status: passed ? 'merge-ready' : 'rejected' };
  await atomicJson(path.join(artifactDir, 'recovery.json'), evidence);
  return evidence;
}
