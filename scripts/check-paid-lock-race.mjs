// Deterministic local probe for the paid-API ledger lock ABA recovery race.
// Before the fix, two recovery processes could both pass an inode/token check,
// then one deleted the replacement live-owner lock, allowing TWO reservations
// from maxWorkerRuns=1 while the ledger showed consumed=1.
//
// This probe creates one grant (limit=1), plants a stale lock, then spawns two
// independent Node processes that both try to reserve. The stale lock is removed
// while they wait, forcing a race to create the replacement lock. With a
// fail-closed lock that never auto-deletes by PID/age/token, exactly ONE
// reservation succeeds. No real paid API calls are made.
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createPaidApiGrant } from '../runtime/paid-authorization.mjs';

const paidAuthorizationModule = new URL('../runtime/paid-authorization.mjs', import.meta.url).href;
const EXAMPLE_ENDPOINT = 'https://api.example.com';

function spawnNode(source, argument) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(argument)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-lock-race-'));
try {
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  await mkdir(project, { recursive: true });

  await createPaidApiGrant(stateDir, {
    project, connectionId: 'race-api', models: ['race-model'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
  });

  // Plant a stale incomplete lock owner. The two reservers must not auto-delete it.
  const lock = path.join(stateDir, 'paid-api', 'ledger.lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 1, token: 'stale-owner', createdAt: 1 }));

  const source = `import { writeFile } from 'node:fs/promises';
import { reservePaidApiRun } from ${JSON.stringify(paidAuthorizationModule)};
const input = JSON.parse(process.argv[1]);
await writeFile(input.readyFile, input.runId + '\\n', { flag: 'a' });
try { await reservePaidApiRun(input); console.log('reserved'); } catch (error) { console.error(error.message); process.exitCode = 2; }`;

  const readyFile = path.join(root, 'ready');
  const args = { stateDir, connectionId: 'race-api', modelId: 'race-model', endpoint: EXAMPLE_ENDPOINT, project, readyFile };
  const a = spawnNode(source, { ...args, runId: 'race-a' });
  const b = spawnNode(source, { ...args, runId: 'race-b' });

  // Wait until both contenders have reached the lock acquisition path.
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    try {
      if ((await readFile(readyFile, 'utf8')).split('\n').filter(Boolean).length >= 2) break;
    } catch { /* not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // Give both contenders a moment to enter acquire() before removing the stale lock.
  await new Promise(resolve => setTimeout(resolve, 100));

  // Now remove the stale lock. The two waiting processes race to create a
  // replacement lock. A correct implementation never deletes a lock it does not
  // own, so exactly one process may reserve the single remaining run.
  await rm(lock, { recursive: true, force: true });

  const [ra, rb] = await Promise.all([a.closed, b.closed]);
  const successes = [ra, rb].filter(r => r.code === 0 && r.stdout.includes('reserved')).length;
  const failures = [ra, rb].filter(r => r.code === 2).length;

  const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  const grant = ledger.grants.find(g => g.connectionId === 'race-api');
  const consumed = grant.consumedWorkerRuns;
  const reservations = ledger.reservations.filter(r => r.connectionId === 'race-api').length;

  const ok = successes === 1 && failures === 1 && consumed === 1 && reservations === 1;
  console.log(JSON.stringify({ ok, successes, failures, consumedWorkerRuns: consumed, reservations, a: { code: ra.code, signal: ra.signal }, b: { code: rb.code, signal: rb.signal } }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
