import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { repairHarness, recoverInterruptedProject } from '../runtime/recovery.mjs';
import { killTree } from '../runtime/process.mjs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/watchdog.mjs recovery-config.json');
const config = JSON.parse(await readFile(file, 'utf8'));
if (!config.harness?.executable || !Array.isArray(config.harness.args)) throw new Error('Harness executable + argv required');
const child = spawn(config.harness.executable, config.harness.args, { cwd: config.harness.cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: 'inherit' });
let recovering = false;
let stopping = false;
let activeChild = child;
let healthTimer;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(healthTimer);
  await killTree(activeChild);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
async function recover(failure) {
  if (recovering || stopping) return; recovering = true;
  await killTree(child);
  try { await recoverInterruptedProject(config); }
  catch (error) { if (error.message !== 'No project state to recover') throw error; }
  const report = await repairHarness({ ...config, failure });
  if (stopping) return;
  // Never restart known-broken source. The tested worktree is the only allowed restart cwd.
  if (report.status !== 'merge-ready' || !config.recovery.restartFromWorktree) {
    console.log(JSON.stringify({ status: report.status, commit: report.commit, worktree: report.tree.directory })); return;
  }
  const restored = spawn(config.harness.executable, config.harness.args, { cwd: report.tree.directory, windowsHide: true, detached: process.platform !== 'win32', stdio: 'inherit' });
  activeChild = restored;
  restored.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
child.on('error', error => void recover(error.message).catch(error => { console.error(error.message); process.exitCode = 1; }));
child.on('exit', (code, signal) => { if (code !== 0 || signal) void recover(`Harness exit ${code}/${signal}`).catch(error => { console.error(error.message); process.exitCode = 1; }); });
if (config.harness.healthUrl) {
  const timer = healthTimer = setInterval(async () => {
    if (recovering) { clearInterval(timer); return; }
    try { const response = await fetch(config.harness.healthUrl, { signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error(`Health HTTP ${response.status}`); }
    catch (error) { try { await recover(error.message); } catch (failure) { console.error(failure.message); clearInterval(timer); process.exitCode = 1; } }
  }, config.harness.healthIntervalMs ?? 10_000);
  child.on('exit', () => clearInterval(timer));
}
