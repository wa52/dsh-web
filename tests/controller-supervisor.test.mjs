import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSupervisedController } from '../runtime/supervisor.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const fingerprintModule = pathToFileURL(path.join(rootDir, 'runtime/process.mjs')).href;

async function fixture(t, { script, finalReport = false, outputLimitBytes } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-controller-supervisor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const finalReportPath = path.join(root, 'acceptance.json');
  const resultPath = path.join(root, 'supervisor-result.json');
  await mkdir(stateDir, { recursive: true });
  if (finalReport) await writeFile(finalReportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  const result = await runSupervisedController({
    executable: process.execPath,
    args: ['--input-type=module', '-e', typeof script === 'function' ? script({ root, stateDir, finalReportPath }) : script],
    cwd: root,
    stateDir,
    finalReportPath,
    resultPath,
    outputLimitBytes,
  });
  return { root, stateDir, finalReportPath, resultPath, result };
}

function durableControllerState(stateDir, { eventPhase = 'DECIDE', status = 'running', actions = [], decisions = [], runs = [] } = {}) {
  const state = { version: 2, status, phase: eventPhase, events: [{ seq: 1, phase: eventPhase }], actions, decisions, runs, failures: [], commits: [], reviews: [], revision: 1 };
  return `const stateDir=${JSON.stringify(stateDir)}; const fs=await import('node:fs/promises'); await fs.writeFile(stateDir+'/world.json',${JSON.stringify(JSON.stringify(state))}); const {processFingerprint}=await import(${JSON.stringify(fingerprintModule)}); const fingerprint=await processFingerprint(process.pid); await fs.writeFile(stateDir+'/runtime.lock',JSON.stringify({pid:process.pid,fingerprint,token:'controller-lock'}));`;
}

test('actual controller exit 1 after durable DECIDE is reported and does not appear live', async t => {
  const history = [{ id: 'prior-action', phase: 'REJECTED', reviews: [{ verdict: 'reject' }] }];
  const run = await fixture(t, { script: ({ stateDir }) => `${durableControllerState(stateDir, { actions: history, decisions: [{ id: 'prior-decision' }] })}\nconsole.log('DECIDE reached'); console.error('API_KEY=sk-secret-value'); process.exitCode=1;` });
  assert.equal(run.result.status, 'FAIL');
  assert.equal(run.result.controller.exitCode, 1);
  assert.equal(run.result.lastDurablePhase, 'DECIDE');
  assert.equal(run.result.recovery.status, 'reconciled');
  assert.match(run.result.stderr.text, /REDACTED/);
  assert.doesNotMatch(run.result.stderr.text, /sk-secret-value/);
  assert.equal(run.result.failureObservation.status, 'FAIL');
  assert.equal(run.result.failureObservation.lastDurablePhase, 'DECIDE');
  assert.equal(run.result.controller.confirmedClosed, true);
  const world = JSON.parse(await readFile(path.join(run.stateDir, 'world.json'), 'utf8'));
  assert.equal(world.status, 'paused');
  assert.deepEqual(world.actions, history);
  assert.deepEqual(world.decisions, [{ id: 'prior-decision' }]);
  assert.equal(world.runs.length, 0);
});

test('zero exit without a final report is still failure', async t => {
  const { result, finalReportPath } = await fixture(t, { script: "console.log('controller ended without acceptance');" });
  assert.equal(result.controller.exitCode, 0);
  assert.equal(result.finalReport.valid, false);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.failureType, 'missing-or-invalid-final-report');
  await assert.rejects(readFile(finalReportPath), { code: 'ENOENT' });
});

test('actual unhandled controller exception remains in bounded stderr evidence', async t => {
  const { result } = await fixture(t, { script: "throw new Error('UNHANDLED_CONTROLLER_DIAGNOSTIC');" });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.controller.exitCode, 1);
  assert.match(result.stderr.text, /UNHANDLED_CONTROLLER_DIAGNOSTIC/);
  assert.equal(result.failureType, 'controller-exit');
});

test('captured process output is byte-bounded and redacted across chunks', async t => {
  const script = "process.stdout.write('x'.repeat(5000)); setTimeout(()=>{process.stdout.write('\\nAPI_KEY=sk-secret-'); setTimeout(()=>process.stdout.write('value\\n'),10);},10);";
  const { result } = await fixture(t, { script, outputLimitBytes: 1024 });
  assert.equal(result.stdout.capturedBytes <= 1024, true);
  assert.equal(result.stdout.truncated, true);
  assert.doesNotMatch(result.stdout.text, /sk-secret-value/);
});

test('actual signal termination is captured by the outside supervisor', { skip: process.platform === 'win32' }, async t => {
  const { result } = await fixture(t, { script: "process.kill(process.pid, 'SIGTERM');" });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.controller.signal, 'SIGTERM');
  assert.equal(result.failureType, 'controller-signal');
});

test('spawn failure is recorded without claiming a child terminated', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-spawn-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const result = await runSupervisedController({ executable: path.join(root, 'missing-controller'), args: [], cwd: root, stateDir, finalReportPath: path.join(root, 'acceptance.json') });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.failureType, 'spawn-failure');
  assert.match(result.controller.spawnFailure, /spawn|ENOENT/i);
  assert.equal(result.controller.confirmedClosed, false);
});

test('successful child preserves a valid final acceptance report byte-for-byte', async t => {
  const finalReport = { status: 'PASS', marker: 'existing-acceptance' };
  const original = `${JSON.stringify(finalReport, null, 2)}\n`;
  const script = ({ finalReportPath }) => `const fs=await import('node:fs/promises'); await fs.unlink(${JSON.stringify(finalReportPath)}); await fs.writeFile(${JSON.stringify(finalReportPath)},${JSON.stringify(original)}); console.log('done');`;
  const { result, finalReportPath, resultPath } = await fixture(t, { script, finalReport });
  assert.equal(result.status, 'PASS');
  assert.equal(result.finalReport.currentRun, true);
  assert.equal(await readFile(finalReportPath, 'utf8'), original);
  assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).finalReport.status, 'PASS');
});

test('a pre-existing passing report is preserved but not attributed to this run', async t => {
  const finalReport = { status: 'PASS', marker: 'prior-run' };
  const original = `${JSON.stringify(finalReport, null, 2)}\n`;
  const { result, finalReportPath } = await fixture(t, { script: 'process.exit(0);', finalReport });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.failureType, 'stale-final-report');
  assert.equal(result.finalReport.currentRun, false);
  assert.equal(await readFile(finalReportPath, 'utf8'), original);
});

test('fresh PASS cannot hide stale running state after controller termination', async t => {
  const report = `${JSON.stringify({ status: 'PASS' })}\n`;
  const { result, stateDir, finalReportPath } = await fixture(t, {
    script: ({ stateDir, finalReportPath }) => `${durableControllerState(stateDir)}\nawait fs.writeFile(${JSON.stringify(finalReportPath)},${JSON.stringify(report)}); process.exit(0);`,
  });
  assert.equal(result.finalReport.currentRun, true);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.failureType, 'stale-runtime-state');
  assert.equal(result.recovery.status, 'reconciled');
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'world.json'), 'utf8')).status, 'paused');
  assert.equal(JSON.parse(await readFile(finalReportPath, 'utf8')).status, 'PASS');
});

test('zero exit cannot reclassify an existing failing final report', async t => {
  const finalReport = { status: 'FAIL', reason: 'acceptance failed' };
  const original = `${JSON.stringify(finalReport, null, 2)}\n`;
  const { result, finalReportPath } = await fixture(t, { script: 'process.exit(0);', finalReport });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.failureType, 'final-report-failure');
  assert.equal(await readFile(finalReportPath, 'utf8'), original);
});

test('safe stale-state recovery follows confirmed controller exit and preserves history', async t => {
  const history = [{ id: 'old-action', phase: 'REJECTED', reviews: [{ reviewer: 'reviewer', verdict: 'reject' }], tests: [{ passed: false }], commit: 'old-commit' }];
  const decisions = [{ id: 'old-decision', reason: 'keep history' }];
  const state = { version: 2, status: 'running', phase: 'DECIDE', events: [{ seq: 1, phase: 'DECIDE' }], actions: history, decisions, runs: [], failures: [], commits: [{ sha: 'old-commit', status: 'candidate' }], reviews: [{ reviewer: 'reviewer', verdict: 'reject' }], revision: 1 };
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-safe-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actualStateDir = path.join(root, 'state');
  await mkdir(actualStateDir, { recursive: true });
  const actualScript = `${durableControllerState(actualStateDir, { actions: history, decisions })}\nconst current=JSON.parse(await fs.readFile(stateDir+'/world.json','utf8')); current.commits=${JSON.stringify(state.commits)}; current.reviews=${JSON.stringify(state.reviews)}; await fs.writeFile(stateDir+'/world.json',JSON.stringify(current)); process.exit(1);`;
  const result = await runSupervisedController({ executable: process.execPath, args: ['--input-type=module', '-e', actualScript], cwd: root, stateDir: actualStateDir, finalReportPath: path.join(root, 'acceptance.json'), resultPath: path.join(root, 'supervisor-result.json') });
  const recovered = JSON.parse(await readFile(path.join(actualStateDir, 'world.json'), 'utf8'));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.lastDurablePhase, 'DECIDE');
  assert.equal(result.recovery.status, 'reconciled');
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.actions[0].commit, 'old-commit');
  assert.deepEqual(recovered.actions[0].reviews, history[0].reviews);
  assert.deepEqual(recovered.actions[0].tests, history[0].tests);
  assert.deepEqual(recovered.decisions, decisions);
  assert.deepEqual(recovered.commits, state.commits);
  assert.equal(recovered.runs.length, 0);
  await assert.rejects(readFile(path.join(actualStateDir, 'runtime.lock')),{ code: 'ENOENT' });
});

test('live lock ownership conflict blocks recovery but still writes a failed report', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-blocked-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const state = { version: 2, status: 'running', phase: 'DECIDE', events: [{ seq: 1, phase: 'DECIDE' }], actions: [], decisions: [], runs: [], failures: [], commits: [], reviews: [], revision: 1 };
  const script = `const stateDir=${JSON.stringify(stateDir)}; const fs=await import('node:fs/promises'); await fs.writeFile(stateDir+'/world.json',${JSON.stringify(JSON.stringify(state))}); const {processFingerprint}=await import(${JSON.stringify(fingerprintModule)}); await fs.writeFile(stateDir+'/runtime.lock',JSON.stringify({pid:process.ppid,fingerprint:await processFingerprint(process.ppid),token:'other-live-owner'})); process.exit(1);`;
  const resultPath = path.join(root, 'supervisor-result.json');
  const result = await runSupervisedController({ executable: process.execPath, args: ['--input-type=module', '-e', script], cwd: root, stateDir, finalReportPath: path.join(root, 'acceptance.json'), resultPath });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.recovery.status, 'blocked');
  assert.match(result.recovery.error, /still exists|ownership conflicts/);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'world.json'), 'utf8')).status, 'running');
  assert.ok(JSON.parse(await readFile(resultPath, 'utf8')));
});

test('PID reuse and Worker descendants without durable identity refuse reconciliation', async t => {
  for (const scenario of ['reused-pid', 'unidentified-worker']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `dsh-${scenario}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateDir = path.join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    const state = { version: 2, status: 'running', phase: 'DECIDE', events: [{ seq: 1, phase: 'DECIDE' }], actions: [], decisions: [], runs: scenario === 'unidentified-worker' ? [{ id: 'unknown-child', status: 'running' }] : [], failures: [], commits: [], reviews: [], revision: 1 };
    const lock = scenario === 'reused-pid'
      ? { pid: 'process.ppid', fingerprint: "'historical-fingerprint'", token: 'reused-pid' }
      : { pid: 'process.pid', fingerprint: 'fingerprint', token: 'unidentified-worker' };
    const script = `const stateDir=${JSON.stringify(stateDir)}; const fs=await import('node:fs/promises'); await fs.writeFile(stateDir+'/world.json',${JSON.stringify(JSON.stringify(state))}); const {processFingerprint}=await import(${JSON.stringify(fingerprintModule)}); const fingerprint=${lock.fingerprint === 'fingerprint' ? 'await processFingerprint(process.pid)' : lock.fingerprint}; await fs.writeFile(stateDir+'/runtime.lock',JSON.stringify({pid:${lock.pid},fingerprint,token:${JSON.stringify(lock.token)}})); process.exit(1);`;
    const resultPath = path.join(root, 'supervisor-result.json');
    const result = await runSupervisedController({ executable: process.execPath, args: ['--input-type=module', '-e', script], cwd: root, stateDir, finalReportPath: path.join(root, 'acceptance.json'), resultPath });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.recovery.status, 'blocked');
    assert.match(result.recovery.error, scenario === 'reused-pid' ? /PID was reused/ : /neither a PID nor a launch token/);
    assert.equal(JSON.parse(await readFile(path.join(stateDir, 'world.json'), 'utf8')).status, 'running');
    assert.ok(JSON.parse(await readFile(path.join(stateDir, 'runtime.lock'), 'utf8')));
    assert.ok(JSON.parse(await readFile(resultPath, 'utf8')));
  }
});
