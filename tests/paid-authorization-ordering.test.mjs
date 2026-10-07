import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPaidApiGrant, revokePaidApiGrant, reservePaidApiRun } from '../runtime/paid-authorization.mjs';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';

const endpoint = 'https://api.example.com';

// Force the first transaction to pause at its first filesystem await. Any
// transaction that overtakes it fails with a distinct error, so this regression
// does not depend on filesystem timing or repeated lucky test runs.
function pauseFirstAcquisition(t, stateDir) {
  const mkdir = fs.mkdir;
  const directory = path.join(stateDir, 'paid-api');
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const mock = t.mock.method(fs, 'mkdir', async (target, options) => {
    if (path.resolve(target) === directory && options?.recursive) {
      calls++;
      if (calls === 1) {
        entered();
        await paused;
      } else if (calls === 2 && !released) {
        throw new Error('Ledger transaction overtook the requested revocation');
      }
    }
    return mkdir(target, options);
  });
  let released = false;
  const release = () => { released = true; resume(); };
  syncBuiltinESMExports();
  t.after(() => { release(); mock.mock.restore(); syncBuiltinESMExports(); });
  return { started, release };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-paid-ordering-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const checkout = await createCheckoutFixture(project);
  const grant = await createPaidApiGrant(stateDir, {
    project, connectionId: 'paid', models: ['paid-model'], endpoint,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
  });
  return { project, stateDir, checkout, grant };
}

async function assertRevokedWithoutConsumption(stateDir) {
  const ledger = JSON.parse(await fs.readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  assert.equal(ledger.grants[0].active, false);
  assert.equal(ledger.grants[0].consumedWorkerRuns, 0);
  assert.deepEqual(ledger.reservations, []);
}

test('revocation requested before reservation wins even when its first filesystem operation is delayed', async t => {
  const { project, stateDir, grant } = await fixture(t);
  const pause = pauseFirstAcquisition(t, stateDir);
  const revocation = revokePaidApiGrant(stateDir, grant.id);
  await pause.started;
  // A normalized alias must use the same in-process queue.
  const reservation = reservePaidApiRun({ stateDir: path.join(stateDir, '.'),
    project, connectionId: 'paid', modelId: 'paid-model', endpoint, runId: 'denied-run' });
  const denied = assert.rejects(reservation, error => error.failureKind === 'authorization-needed');
  const completed = Promise.all([revocation, denied]);
  completed.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  pause.release();
  await completed;
  await assertRevokedWithoutConsumption(stateDir);
  // Rejection must release the local queue as well as the physical lock.
  await assert.rejects(revokePaidApiGrant(stateDir, 'unknown'), /Unknown paid API grant/);
  await revokePaidApiGrant(stateDir, grant.id);
});

test('real execute rejects a stale paid selection and prepares only a funded worker with delayed revocation', async t => {
  const { project, stateDir, checkout, grant } = await fixture(t);
  const starts = [];
  const worker = (id, model, paidApi) => ({
    id, identity: `${id}-identity`, provider: 'opencode', connectionId: id,
    model, paidApi, roles: ['build'], capabilities: ['code'],
    ...(paidApi ? { openCodeProvider: { id: 'fixture-paid-provider', name: 'Local fixture', baseURL: endpoint } } : {}),
    availability: 'online', trust: 0.8, cost: 1,
    describe() { return { id, identity: this.identity, provider: this.provider, roles: this.roles, availability: this.availability }; },
    async start(task) {
      starts.push({ id, model: task.model });
      return { id: task.runKey, result: Promise.resolve({ summary: 'local fixture' }), dispose: async () => {} };
    },
  });
  const paid = worker('paid', 'paid-model', { endpoint });
  const funded = worker('funded', 'funded-model');
  const runtime = new ProjectRuntime({ ...checkout, stateDir,
    models: [
      { id: 'paid-model', provider: 'opencode', connectionId: 'paid', tier: 'routine', paid: true, endpoint },
      { id: 'funded-model', provider: 'opencode', connectionId: 'funded', tier: 'routine' },
    ],
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
  }, { agents: [paid, funded] });
  await runtime.initialize();
  const resolve = runtime.resolveAgentForTask.bind(runtime);
  let revocation;
  let pause;
  runtime.resolveAgentForTask = (initial, task) => {
    const selected = resolve(initial, task);
    if (!revocation && selected.agent === paid) {
      pause = pauseFirstAcquisition(t, stateDir);
      revocation = revokePaidApiGrant(stateDir, grant.id);
      // Give a competing transaction a turn while revocation is paused.
      pause.started.then(() => setImmediate(pause.release));
    }
    return selected;
  };
  await runtime.execute(paid, { role: 'build', workspace: project, prompt: 'local fixture', capabilities: ['code'] });
  assert.ok(revocation, 'the stale paid selection actually triggered revocation');
  await revocation;
  assert.deepEqual(starts, [{ id: 'funded', model: 'funded-model' }]);
  assert.deepEqual(runtime.state.runs.map(run => run.worker), ['funded']);
  await assertRevokedWithoutConsumption(stateDir);
});
