import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { routeModel, unavailableAgentIds, RoutingError } from '../runtime/routing.mjs';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { ProjectRuntime } from '../runtime/project.mjs';
import { killTree } from '../runtime/process.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';
import { createPaidApiGrant, revokePaidApiGrant, reservePaidApiRun, eligiblePaidConnections, assertPaidApiRunAuthorization, hasPaidApiRunAuthorization } from '../runtime/paid-authorization.mjs';

const EXAMPLE_ENDPOINT = 'https://api.example.com';
const paidAuthorizationModule = new URL('../runtime/paid-authorization.mjs', import.meta.url).href;

function spawnNode(source, argument) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(argument)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed, output: () => ({ stdout, stderr }) };
}

function tdAgent({ id, identity = `${id}-identity`, identityAliases = [], provider = 'test-double', connectionId, quotaGroup, paidApi, openCodeProvider, model, roles = ['build'], capabilities = ['code', 'reason', 'review'], trust = 0.8, behavior }) {
  return {
    id,
    identity,
    identityAliases,
    provider,
    ...(connectionId ? { connectionId } : {}),
    ...(quotaGroup ? { quotaGroup } : {}),
    ...(paidApi ? { paidApi } : {}),
    ...(openCodeProvider ? { openCodeProvider } : {}),
    ...(model ? { model } : {}),
    roles,
    capabilities,
    availability: 'online',
    trust,
    cost: 1,
    describe() { return { id, identity: this.identity, provider, roles: this.roles, availability: this.availability }; },
    async start(task) { return behavior(task); },
  };
}

test('Go quota exhaustion does not quarantine an independently funded opencode connection', () => {
  const agents = [
    { id: 'go', provider: 'opencode', connectionId: 'opencode-go', availability: 'offline', quotaGroup: 'go-account' },
    { id: 'subscription', provider: 'opencode', connectionId: 'opencode-subscription', availability: 'online' },
  ];
  const unavailable = unavailableAgentIds(agents);
  assert.ok(unavailable.has('go'), 'the exhausted connection is offline');
  assert.ok(!unavailable.has('subscription'), 'independent login is still available');
  const unavailableConnections = agents.filter(agent => unavailable.has(agent.id)).map(agent => agent.connectionId ?? agent.id);
  const catalog = [
    { id: 'deepseek-v4.1-flash', provider: 'opencode', connectionId: 'opencode-go', tier: 'routine' },
    { id: 'account-model', provider: 'opencode', connectionId: 'opencode-subscription', tier: 'routine' },
  ];
  assert.equal(routeModel({ provider: 'opencode', connectionId: 'opencode-subscription' }, catalog).selectedModel, 'account-model');
  assert.throws(() => routeModel({ provider: 'opencode', connectionId: 'opencode-go', unavailable: unavailableConnections }, catalog), err => err instanceof RoutingError && err.code === 'NO_ELIGIBLE_MODEL');
});

test('identical model id on another account remains usable after a connection-scoped failure', () => {
  const catalog = [
    { id: 'shared-flash', provider: 'opencode', connectionId: 'conn-a', tier: 'routine' },
    { id: 'shared-flash', provider: 'opencode', connectionId: 'conn-b', tier: 'routine' },
  ];
  assert.equal(
    routeModel({ provider: 'opencode', connectionId: 'conn-b', unavailable: ['conn-a::shared-flash'] }, catalog).selectedModel,
    'shared-flash',
    'scoped failure only excludes the failing connection'
  );
  assert.throws(
    () => routeModel({ provider: 'opencode', connectionId: 'conn-a', unavailable: ['conn-a::shared-flash'] }, catalog),
    /No eligible/,
    'the same failure does exclude its own connection'
  );
  // When distinct connection identities make a model id unambiguous, bare id exclusion must not cross accounts.
  assert.equal(
    routeModel({ provider: 'opencode', connectionId: 'conn-b', unavailable: ['shared-flash'] }, catalog).selectedModel,
    'shared-flash',
    'bare model id must not exclude the same id on another account'
  );
});

test('legacy connectionId-less catalog still honours bare model-id exclusion', () => {
  const catalog = [
    { id: 'oc-routine', provider: 'opencode', tier: 'routine' },
    { id: 'pi-routine', provider: 'pi', tier: 'routine' },
  ];
  assert.throws(() => routeModel({ provider: 'opencode', unavailable: ['oc-routine'] }, catalog), /No eligible/);
  assert.equal(routeModel({ provider: 'pi', unavailable: ['oc-routine'] }, catalog).selectedModel, 'pi-routine');
});

test('paid API grant lifecycle, expiry, revocation, forged tokens and concurrent reservations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');

  const grant = await createPaidApiGrant(stateDir, {
    project, connectionId: 'deepseek-api', models: ['deepseek-flash'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 2,
  });
  assert.ok(grant.id);
  assert.equal(grant.maxWorkerRuns, 2);

  const key = `deepseek-api\0deepseek-flash\0${EXAMPLE_ENDPOINT}`;
  assert.ok((await eligiblePaidConnections({ stateDir, project, requirements: [{ connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT }] })).includes(key));

  const r1 = await reservePaidApiRun({ stateDir, connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-1' });
  assert.ok(hasPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-1' }));
  assert.ok(hasPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-1' }), 'has check is non-consuming');
  assertPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-1' });
  assert.ok(!hasPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-1' }), 'capability is consumed once');

  await reservePaidApiRun({ stateDir, connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-2' });
  await assert.rejects(
    reservePaidApiRun({ stateDir, connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-3' }),
    /Paid API authorization needed/
  );

  await revokePaidApiGrant(stateDir, grant.id);
  await assert.rejects(
    reservePaidApiRun({ stateDir, connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, project, runId: 'run-4' }),
    /Paid API authorization needed/
  );

  await t.test('concurrent reservations do not overspend a single remaining run', async () => {
    const g = await createPaidApiGrant(stateDir, {
      project, connectionId: 'glm-api', models: ['glm-5.3-flash'], endpoint: 'https://api.z.ai/api/paas/v4',
      expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
    });
    const results = await Promise.all([1, 2].map(i => reservePaidApiRun({
      stateDir, connectionId: 'glm-api', modelId: 'glm-5.3-flash', endpoint: 'https://api.z.ai/api/paas/v4', project, runId: `concurrent-${i}`,
    }).then(r => ({ status: 'fulfilled', r }), e => ({ status: 'rejected', e }))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'only one concurrent reservation may succeed');
    const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
    const row = ledger.grants.find(row => row.id === g.id);
    assert.equal(row.consumedWorkerRuns, 1);
  });

  await t.test('independent Node processes preserve the one-run limit', async () => {
    const g = await createPaidApiGrant(stateDir, {
      project, connectionId: 'independent-process-api', models: ['fixture-model'], endpoint: EXAMPLE_ENDPOINT,
      expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
    });
    const source = `import { reservePaidApiRun } from ${JSON.stringify(paidAuthorizationModule)};\nconst input = JSON.parse(process.argv[1]);\ntry { await reservePaidApiRun(input); console.log('reserved'); } catch (error) { console.error(error.message); process.exitCode = 2; }`;
    const attempts = await Promise.all([1, 2].map(index => {
      const process = spawnNode(source, {
        stateDir, connectionId: 'independent-process-api', modelId: 'fixture-model', endpoint: EXAMPLE_ENDPOINT,
        project, runId: `independent-${index}`,
      });
      return process.closed;
    }));
    assert.equal(attempts.filter(result => result.code === 0 && result.stdout.includes('reserved')).length, 1);
    assert.equal(attempts.filter(result => result.code === 2).length, 1);
    const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
    assert.equal(ledger.grants.find(row => row.id === g.id).consumedWorkerRuns, 1);
    assert.equal(ledger.reservations.filter(row => row.connectionId === 'independent-process-api').length, 1);
  });

  await t.test('forged or mismatched authorization capability is rejected', async () => {
    const g = await createPaidApiGrant(stateDir, {
      project, connectionId: 'forged-api', models: ['forged-model'], endpoint: EXAMPLE_ENDPOINT,
      expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
    });
    const r = await reservePaidApiRun({ stateDir, connectionId: 'forged-api', modelId: 'forged-model', endpoint: EXAMPLE_ENDPOINT, project, runId: 'forged-run' });
    assert.throws(() => assertPaidApiRunAuthorization(r, { connectionId: 'forged-api', modelId: 'forged-model', endpoint: EXAMPLE_ENDPOINT, project, runId: 'wrong-run' }), /Paid API authorization needed/);
    assert.throws(() => assertPaidApiRunAuthorization(r, { connectionId: 'forged-api', modelId: 'forged-model', endpoint: EXAMPLE_ENDPOINT, project: `${project}-other`, runId: 'forged-run' }), /Paid API authorization needed/);
    assert.throws(() => assertPaidApiRunAuthorization(r, { connectionId: 'forged-api', modelId: 'forged-model', endpoint: 'https://wrong.example.com', project, runId: 'forged-run' }), /Paid API authorization needed/);
    assert.throws(() => assertPaidApiRunAuthorization({}, { connectionId: 'forged-api', modelId: 'forged-model', endpoint: EXAMPLE_ENDPOINT, project, runId: 'forged-run' }), /Paid API authorization needed/);
    await revokePaidApiGrant(stateDir, g.id);
  });

  await t.test('expired grant is not eligible', async () => {
    const g = await createPaidApiGrant(stateDir, {
      project, connectionId: 'expired-api', models: ['expired-model'], endpoint: EXAMPLE_ENDPOINT,
      expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 5,
    });
    const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
    const row = ledger.grants.find(row => row.id === g.id);
    row.expiresAt = '2000-01-01T00:00:00Z';
    await writeFile(path.join(stateDir, 'paid-api', 'ledger.json'), JSON.stringify(ledger, null, 2));
    assert.equal((await eligiblePaidConnections({ stateDir, project, requirements: [{ connectionId: 'expired-api', modelId: 'expired-model', endpoint: EXAMPLE_ENDPOINT }] })).length, 0);
    await assert.rejects(
      reservePaidApiRun({ stateDir, connectionId: 'expired-api', modelId: 'expired-model', endpoint: EXAMPLE_ENDPOINT, project, runId: 'expired-run' }),
      /Paid API authorization needed/
    );
  });
});

test('a crashed lock owner is never auto-recovered and cannot overspend the grant', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-stale-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  await createPaidApiGrant(stateDir, {
    project, connectionId: 'stale-lock-api', models: ['fixture-model'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
  });
  const lock = path.join(stateDir, 'paid-api', 'ledger.lock');
  const abandonLock = spawnNode(`import { mkdir, writeFile } from 'node:fs/promises';\nconst lock = JSON.parse(process.argv[1]);\nawait mkdir(lock);\nawait writeFile(lock + '/owner.json', JSON.stringify({ pid: process.pid, token: 'crashed-owner', createdAt: 1 }));`, lock);
  const abandoned = await abandonLock.closed;
  assert.equal(abandoned.code, 0, abandoned.stderr);

  const readyFile = path.join(root, 'reserve-attempt-started');
  const reserveSource = `import { writeFile } from 'node:fs/promises';\nimport { reservePaidApiRun } from ${JSON.stringify(paidAuthorizationModule)};\nconst input = JSON.parse(process.argv[1]);\nawait writeFile(input.readyFile, 'attempting');\ntry { await reservePaidApiRun(input); console.log('reserved'); } catch (error) { console.error(error.message); process.exitCode = 2; }`;
  const attempt = spawnNode(reserveSource, {
    stateDir, connectionId: 'stale-lock-api', modelId: 'fixture-model', endpoint: EXAMPLE_ENDPOINT,
    project, readyFile, runId: 'must-remain-blocked',
  });
  try {
    let ready = false;
    for (let retry = 0; retry < 100 && !ready; retry++) {
      try { ready = (await readFile(readyFile, 'utf8')) === 'attempting'; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'the independent reserver reached the lock acquisition path');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(attempt.child.exitCode, null, 'the second process must wait rather than steal a stale owner lock');
    assert.deepEqual(attempt.output(), { stdout: '', stderr: '' });
  } finally {
    await killTree(attempt.child);
    await attempt.closed;
  }
  assert.equal((await readFile(path.join(lock, 'owner.json'), 'utf8')).includes('crashed-owner'), true, 'stale lock owner must be preserved for explicit operator recovery');
  const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  assert.equal(ledger.grants[0].consumedWorkerRuns, 0);
  assert.equal(ledger.reservations.length, 0);
  // The test owns this isolated state directory and all child processes have
  // stopped, matching the documented operator-only recovery precondition.
  await rm(lock, { recursive: true, force: true });
  const source = `import { reservePaidApiRun } from ${JSON.stringify(paidAuthorizationModule)};\nconst input = JSON.parse(process.argv[1]);\ntry { await reservePaidApiRun(input); console.log('reserved'); } catch (error) { console.error(error.message); process.exitCode = 2; }`;
  const recoveredAttempts = await Promise.all([1, 2].map(index => spawnNode(source, {
    stateDir, connectionId: 'stale-lock-api', modelId: 'fixture-model', endpoint: EXAMPLE_ENDPOINT,
    project, runId: `after-recovery-${index}`,
  }).closed));
  assert.equal(recoveredAttempts.filter(result => result.code === 0 && result.stdout.includes('reserved')).length, 1, 'operator recovery must preserve the original one-run limit');
  assert.equal(recoveredAttempts.filter(result => result.code === 2).length, 1);
  const recoveredLedger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  assert.equal(recoveredLedger.grants[0].consumedWorkerRuns, 1);
  assert.equal(recoveredLedger.reservations.length, 1);
});

test('an incomplete paid-ledger lock also fails closed until operator recovery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-incomplete-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  await createPaidApiGrant(stateDir, {
    project, connectionId: 'incomplete-lock-api', models: ['fixture-model'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
  });
  const lock = path.join(stateDir, 'paid-api', 'ledger.lock');
  await mkdir(lock);
  const readyFile = path.join(root, 'attempt-ready');
  const source = `import { writeFile } from 'node:fs/promises';\nimport { reservePaidApiRun } from ${JSON.stringify(paidAuthorizationModule)};\nconst input = JSON.parse(process.argv[1]); await writeFile(input.readyFile, 'ready'); try { await reservePaidApiRun(input); console.log('reserved'); } catch (error) { console.error(error.message); process.exitCode = 2; }`;
  const attempt = spawnNode(source, {
    stateDir, connectionId: 'incomplete-lock-api', modelId: 'fixture-model', endpoint: EXAMPLE_ENDPOINT,
    project, readyFile, runId: 'must-remain-blocked',
  });
  try {
    let ready = false;
    for (let retry = 0; retry < 100 && !ready; retry++) {
      try { ready = (await readFile(readyFile, 'utf8')) === 'ready'; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(attempt.child.exitCode, null, 'an incomplete lock is not deleted based on absent owner metadata');
    await assert.rejects(readFile(path.join(lock, 'owner.json'), 'utf8'), { code: 'ENOENT' });
    const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
    assert.equal(ledger.grants[0].consumedWorkerRuns, 0);
    assert.equal(ledger.reservations.length, 0);
  } finally {
    await killTree(attempt.child);
    await attempt.closed;
    await rm(lock, { recursive: true, force: true });
  }
});

test('denied paid choices fail before adapter start and do not consume usage', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-denied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const fixture = await createCheckoutFixture(project);
  const models = [
    { id: 'deepseek-flash', provider: 'opencode', connectionId: 'deepseek-api', tier: 'routine', paid: true, endpoint: EXAMPLE_ENDPOINT },
  ];
  let started = false;
  const paidAgent = tdAgent({
    id: 'deepseekApi', provider: 'opencode', connectionId: 'deepseek-api', model: 'deepseek-flash',
    paidApi: { endpoint: EXAMPLE_ENDPOINT },
    openCodeProvider: { id: 'deepseek-paid', name: 'DeepSeek', baseURL: EXAMPLE_ENDPOINT, apiKeyEnv: 'DEEPSEEK_API_KEY' },
    roles: ['build'],
    behavior: async () => { started = true; return { id: randomUUID(), result: Promise.resolve({ summary: 'ok' }), dispose: async () => {} }; },
  });
  const runtime = new ProjectRuntime({
    ...fixture, stateDir, models,
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
  }, { agents: [paidAgent] });
  await runtime.initialize();
  await assert.rejects(
    runtime.execute(paidAgent, { role: 'build', workspace: project, runKey: randomUUID(), prompt: 'test', capabilities: ['code'], timeoutMs: 5000 }),
    err => err.failureKind === 'authorization-needed'
  );
  assert.equal(started, false, 'adapter start must not be called without authorization');
  for (const [name, overrides] of [
    ['static-routing', { autoModelRouting: false }],
    ['no-catalog', { models: undefined }],
  ]) {
    const settings = { ...fixture, stateDir: path.join(root, `state-${name}`), models, ...overrides,
      tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }], protectedPaths: ['tests/acceptance.test.mjs'] };
    if (name === 'no-catalog') delete settings.models;
    const ungranted = new ProjectRuntime(settings, { agents: [paidAgent] });
    await ungranted.initialize();
    await assert.rejects(ungranted.execute(paidAgent, { role: 'build', workspace: project, runKey: randomUUID(), prompt: 'test', capabilities: ['code'] }), error => error.failureKind === 'authorization-needed');
    assert.equal(started, false, `${name} must not start the paid adapter without a grant`);
  }
});

test('authorized synthetic paid fixture starts with a valid capability and consumes one run', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-ok-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const fixture = await createCheckoutFixture(project);
  const GLM_ENDPOINT = 'https://api.z.ai/api/paas/v4';
  const models = [
    { id: 'glm-5.3-flash', provider: 'opencode', connectionId: 'glm-api', tier: 'routine', paid: true, endpoint: GLM_ENDPOINT },
  ];
  await createPaidApiGrant(stateDir, {
    project, connectionId: 'glm-api', models: ['glm-5.3-flash'], endpoint: GLM_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 3,
  });
  let received;
  const paidAgent = tdAgent({
    id: 'glmApi', provider: 'opencode', connectionId: 'glm-api', model: 'glm-5.3-flash',
    paidApi: { endpoint: GLM_ENDPOINT },
    openCodeProvider: { id: 'glm-paid', name: 'GLM', baseURL: GLM_ENDPOINT, apiKeyEnv: 'GLM_API_KEY' },
    roles: ['build'],
    behavior: async task => {
      received = task;
      assert.ok(hasPaidApiRunAuthorization(task.paidApiAuthorization, { connectionId: 'glm-api', modelId: 'glm-5.3-flash', endpoint: GLM_ENDPOINT, project, runId: task.runKey }));
      return { id: task.runKey, result: Promise.resolve({ summary: 'ok' }), dispose: async () => {} };
    },
  });
  const runtime = new ProjectRuntime({
    ...fixture, stateDir, models,
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
  }, { agents: [paidAgent] });
  await runtime.initialize();
  await runtime.execute(paidAgent, { role: 'build', workspace: project, runKey: randomUUID(), prompt: 'test', capabilities: ['code'], timeoutMs: 5000 });
  assert.ok(received.paidApiAuthorization, 'adapter received a capability');
  assert.equal(received.model, 'glm-5.3-flash');
  const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  const grant = ledger.grants.find(g => g.connectionId === 'glm-api' && g.endpoint === GLM_ENDPOINT);
  assert.equal(grant.consumedWorkerRuns, 1);
  assert.equal(ledger.reservations.filter(r => r.connectionId === 'glm-api').length, 1);
  assert.equal(ledger.reservations.find(r => r.connectionId === 'glm-api').runId, received.runKey);
});

test('a direct paid adapter start cannot bypass Host reservation', async () => {
  const project = path.join(os.tmpdir(), 'dsh-paid-direct-project');
  const adapter = createAgentAdapter('opencode', {
    id: 'direct-paid-api', connectionId: 'direct-paid-api', model: 'fixture-model',
    paidApi: { endpoint: EXAMPLE_ENDPOINT },
    openCodeProvider: { id: 'fixture-paid', name: 'Local fixture only', baseURL: EXAMPLE_ENDPOINT },
  });
  await assert.rejects(adapter.start({
    model: 'fixture-model', runKey: randomUUID(), project,
    workspace: project, artifactDir: path.join(os.tmpdir(), 'dsh-paid-direct-artifacts'), prompt: 'local fixture only',
  }), /Paid API authorization needed/);
});

test('read-only custom provider config preserves Host permission and tool fences', async () => {
  process.env.DEEPSEEK_API_KEY = 'fake-key-do-not-leak';
  try {
    const adapter = createAgentAdapter('opencode', {
      id: 'deepseekApi', identity: 'reviewer-primary', identityAliases: ['reviewer-session-alias'], connectionId: 'deepseek-api', model: 'deepseek-flash', roles: ['review'],
      paidApi: { endpoint: EXAMPLE_ENDPOINT },
      openCodeProvider: { id: 'deepseek-paid', name: 'DeepSeek V4.1 Flash (Paid API)', baseURL: EXAMPLE_ENDPOINT, apiKeyEnv: 'DEEPSEEK_API_KEY', modelName: 'DeepSeek V4.1 Flash' },
    });
    assert.equal(adapter.identity, 'reviewer-primary');
    assert.deepEqual(adapter.identityAliases, ['reviewer-session-alias']);
    const spec = await adapter.prepare({
      role: 'review', workspace: 'D:/tmp', artifactDir: 'D:/tmp', runKey: randomUUID(),
      permissions: { read: true, write: false }, prompt: 'review', outputSchema: { verdict: 'string' },
    });
    const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.permission.bash, 'deny');
    assert.equal(config.permission.edit, 'deny');
    assert.equal(config.permission.webfetch, 'deny');
    assert.equal(config.permission.websearch, 'deny');
    assert.deepEqual(config.plugin, []);
    assert.ok(Object.values(config.mcp).every(m => m.enabled === false));
    assert.equal(config.provider['deepseek-paid'].options.baseURL, EXAMPLE_ENDPOINT);
    assert.equal(config.provider['deepseek-paid'].models['deepseek-flash'].name, 'DeepSeek V4.1 Flash');
    assert.equal(config.provider['deepseek-paid'].options.apiKey, '{env:DEEPSEEK_API_KEY}');
    assert.ok(!spec.env.OPENCODE_CONFIG_CONTENT.includes('fake-key-do-not-leak'), 'no raw key is embedded in generated config');
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('paid authorization ledger never stores credentials or raw keys', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  await createPaidApiGrant(stateDir, {
    project, connectionId: 'secret-api', models: ['secret-model'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
  });
  const ledgerText = await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8');
  assert.ok(!ledgerText.includes('apiKey'));
  assert.ok(!ledgerText.includes('password'));
  assert.ok(ledgerText.includes('projectKey'), 'only a hashed project binding is stored');
});

test('real high-risk review fallback retains security capability and excludes every Builder alias', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-independence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const fixture = await createCheckoutFixture(project);
  const models = [
    { id: 'paid-routine-review', provider: 'opencode', connectionId: 'paid-review', tier: 'routine', paid: true, endpoint: EXAMPLE_ENDPOINT },
    { id: 'funded-security', provider: 'opencode', connectionId: 'funded-security', tier: 'security' },
    { id: 'funded-deep', provider: 'opencode', connectionId: 'funded-security', tier: 'deep' },
    { id: 'funded-independent-deep', provider: 'opencode', connectionId: 'funded-independent', tier: 'deep' },
    { id: 'builder-alias-security', provider: 'opencode', connectionId: 'builder-alias-connection', tier: 'security' },
    { id: 'builder-security-model', provider: 'opencode', connectionId: 'builder-account', tier: 'security' },
  ];
  await createPaidApiGrant(stateDir, {
    project, connectionId: 'paid-review', models: ['paid-routine-review'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 2,
  });
  let paidStarts = 0;
  let builderAliasStarts = 0;
  const selectedReviewers = [];
  const builder = tdAgent({ id: 'fixture-builder', identity: 'builder-primary', identityAliases: ['builder-session-alias'], provider: 'opencode', connectionId: 'builder-account', roles: ['build', 'review'], capabilities: ['code', 'reason', 'review', 'security'], behavior: async () => { throw new Error('Builder must never be selected as a reviewer'); } });
  const paid = tdAgent({ id: 'paid-security-reviewer', identity: 'paid-review-identity', identityAliases: ['paid-review-alias'], provider: 'opencode', connectionId: 'paid-review', paidApi: { endpoint: EXAMPLE_ENDPOINT }, openCodeProvider: { id: 'paid-review-provider', name: 'Paid review fixture', baseURL: EXAMPLE_ENDPOINT }, roles: ['review'], capabilities: ['review', 'security'], trust: 1,
    behavior: async task => { paidStarts++; return { id: task.runKey, result: Promise.resolve({ verdict: 'pass', reason: 'unexpected paid start', evidence: ['fixture'], blockingRisks: [] }), dispose: async () => {} }; } });
  const builderAlias = tdAgent({ id: 'builder-alias-worker', identity: 'builder-session-alias', provider: 'opencode', connectionId: 'builder-alias-connection', roles: ['review'], capabilities: ['review', 'security'], trust: 0.95,
    behavior: async task => { builderAliasStarts++; return { id: task.runKey, result: Promise.resolve({ verdict: 'pass', reason: 'Builder alias must not review', evidence: ['fixture'], blockingRisks: [] }), dispose: async () => {} }; } });
  const securityFallback = tdAgent({ id: 'funded-security-reviewer', identity: 'security-fallback-identity', identityAliases: ['security-fallback-alias'], provider: 'opencode', connectionId: 'funded-security', roles: ['review'], capabilities: ['review', 'security'], trust: 0.7,
    behavior: async task => { selectedReviewers.push({ id: 'funded-security-reviewer', capabilities: task.capabilities, security: task.security }); return { id: task.runKey, result: Promise.resolve({ verdict: 'pass', reason: 'Security review passed', evidence: ['funded fixture review'], blockingRisks: [] }), dispose: async () => {} }; } });
  const independentFallback = tdAgent({ id: 'funded-independent-reviewer', identity: 'independent-review-identity', provider: 'opencode', connectionId: 'funded-independent', roles: ['review'], capabilities: ['review'], trust: 0.6,
    behavior: async task => { selectedReviewers.push({ id: 'funded-independent-reviewer', capabilities: task.capabilities, security: task.security }); return { id: task.runKey, result: Promise.resolve({ verdict: 'pass', reason: 'Independent review passed', evidence: ['funded fixture review'], blockingRisks: [] }), dispose: async () => {} }; } });
  const runtime = new ProjectRuntime({
    ...fixture, stateDir, models, maxReviewAttempts: 2,
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
  }, { agents: [builder, paid, builderAlias, securityFallback, independentFallback] });
  await runtime.initialize();
  const tree = await runtime.worktrees.create(randomUUID(), 'build', runtime.state.acceptedHead);
  await writeFile(path.join(tree.directory, 'checkout.mjs'), 'export const total = items => items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);\nexport const delivery = items => items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) >= 30 ? 0 : 5;\n');
  await writeFile(path.join(tree.directory, 'style.css'), '.checkout { display: block; padding: 16px; }\n');
  const commit = await runtime.worktrees.commit(tree, 'independence regression fixture');
  const snapshot = await runtime.worktrees.snapshot(tree.directory);
  const diff = await runtime.worktrees.diff({ ...tree, base: runtime.state.acceptedHead });
  const action = {
    id: randomUUID(), goal: 'Review the high-risk candidate', risk: 'high', builder: builder.id, builderIdentity: builder.identity,
    builderHistory: [builder.id], builderIdentities: [builder.identity, ...builder.identityAliases], worktree: tree,
    acceptedBase: runtime.state.acceptedHead, commit, snapshot, diff, actionDiff: await runtime.worktrees.diff(tree),
    tests: [{ passed: true }], protectedIntact: true, phase: 'REVIEW_REQUIRED', reviews: [],
  };
  runtime.state.actions.push(action);
  runtime.state.commits.push({ actionId: action.id, sha: commit, status: 'candidate' });
  await runtime.review(action);

  assert.equal(action.phase, 'MERGE_READY');
  assert.deepEqual(action.reviews.map(review => [review.reviewer, review.capability]), [
    ['funded-security-reviewer', 'security'],
    ['funded-independent-reviewer', 'review'],
  ]);
  assert.equal(selectedReviewers[0].security, true);
  assert.ok(selectedReviewers[0].capabilities.includes('security'), 'fallback task retains security capability');
  assert.equal(new Set(action.reviews.map(review => review.reviewer)).size, 2, 'the required independent reviews cannot collapse to one actor');
  assert.ok(action.reviews.every(review => review.reviewer !== builder.id));
  assert.ok(action.reviews.every(review => !['builder-primary', 'builder-session-alias'].includes(review.reviewer)));
  assert.equal(paidStarts, 0, 'routine-only paid model is not started for security or high-risk review');
  assert.equal(builderAliasStarts, 0, 'an alternate adapter exposing a Builder identity alias is excluded before preparation');
  const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  assert.equal(ledger.grants[0].consumedWorkerRuns, 0);
  assert.equal(ledger.reservations.length, 0);
});

test('real execute refreshes exhausted paid eligibility and falls back before another paid start', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-execute-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const fixture = await createCheckoutFixture(project);
  const models = [
    { id: 'paid-fixture', provider: 'opencode', connectionId: 'paid-connection', tier: 'routine', paid: true, endpoint: EXAMPLE_ENDPOINT },
    { id: 'funded-fixture', provider: 'opencode', connectionId: 'funded-connection', tier: 'routine' },
  ];
  await createPaidApiGrant(stateDir, {
    project, connectionId: 'paid-connection', models: ['paid-fixture'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
  });
  const starts = [];
  const paid = tdAgent({ id: 'paid-worker', provider: 'opencode', connectionId: 'paid-connection', model: 'paid-fixture',
    paidApi: { endpoint: EXAMPLE_ENDPOINT }, openCodeProvider: { id: 'paid-fixture-provider', name: 'Paid fixture', baseURL: EXAMPLE_ENDPOINT }, roles: ['build'],
    behavior: async task => { starts.push({ worker: 'paid', model: task.model }); return { id: task.runKey, result: Promise.resolve({ summary: 'paid fixture' }), dispose: async () => {} }; } });
  const funded = tdAgent({ id: 'funded-worker', provider: 'opencode', connectionId: 'funded-connection', model: 'funded-fixture', roles: ['build'],
    behavior: async task => { starts.push({ worker: 'funded', model: task.model }); return { id: task.runKey, result: Promise.resolve({ summary: 'funded fixture' }), dispose: async () => {} }; } });
  const runtime = new ProjectRuntime({ ...fixture, stateDir, models,
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
  }, { agents: [paid, funded] });
  await runtime.initialize();

  await runtime.execute(paid, { role: 'build', workspace: project, prompt: 'local fixture', capabilities: ['code'] });
  await runtime.execute(paid, { role: 'build', workspace: project, prompt: 'local fixture', capabilities: ['code'] });

  assert.deepEqual(starts, [
    { worker: 'paid', model: 'paid-fixture' },
    { worker: 'funded', model: 'funded-fixture' },
  ]);
  const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  assert.equal(ledger.grants[0].consumedWorkerRuns, 1);
  assert.deepEqual(ledger.reservations.map(row => row.connectionId), ['paid-connection']);
});

test('real execute refreshes after a paid reservation loses a concurrent revocation race', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-paid-revocation-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const fixture = await createCheckoutFixture(project);
  const models = [
    { id: 'revoked-paid-fixture', provider: 'opencode', connectionId: 'revoked-paid', tier: 'routine', paid: true, endpoint: EXAMPLE_ENDPOINT },
    { id: 'revocation-funded-fixture', provider: 'opencode', connectionId: 'revocation-funded', tier: 'routine' },
  ];
  const grant = await createPaidApiGrant(stateDir, {
    project, connectionId: 'revoked-paid', models: ['revoked-paid-fixture'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
  });
  let paidStarts = 0;
  let fundedStarts = 0;
  const paid = tdAgent({ id: 'revoked-paid-worker', provider: 'opencode', connectionId: 'revoked-paid', model: 'revoked-paid-fixture',
    paidApi: { endpoint: EXAMPLE_ENDPOINT }, openCodeProvider: { id: 'revoked-paid-provider', name: 'Revoked paid fixture', baseURL: EXAMPLE_ENDPOINT }, roles: ['build'],
    behavior: async task => { paidStarts++; return { id: task.runKey, result: Promise.resolve({ summary: 'unexpected paid start' }), dispose: async () => {} }; } });
  const funded = tdAgent({ id: 'revocation-funded-worker', provider: 'opencode', connectionId: 'revocation-funded', model: 'revocation-funded-fixture', roles: ['build'],
    behavior: async task => { fundedStarts++; return { id: task.runKey, result: Promise.resolve({ summary: 'funded fallback' }), dispose: async () => {} }; } });
  const runtime = new ProjectRuntime({ ...fixture, stateDir, models,
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
  }, { agents: [paid, funded] });
  await runtime.initialize();
  const resolve = runtime.resolveAgentForTask.bind(runtime);
  let revocation;
  runtime.resolveAgentForTask = (initial, task) => {
    const selected = resolve(initial, task);
    if (!revocation && selected.agent === paid) revocation = revokePaidApiGrant(stateDir, grant.id);
    return selected;
  };

  await runtime.execute(paid, { role: 'build', workspace: project, prompt: 'local revocation fixture', capabilities: ['code'] });
  await revocation;

  assert.equal(paidStarts, 0, 'the stale paid choice is denied before adapter preparation');
  assert.equal(fundedStarts, 1, 'execute retries a funded peer after refreshing the revoked grant');
  const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  assert.equal(ledger.grants[0].active, false);
  assert.equal(ledger.grants[0].consumedWorkerRuns, 0);
  assert.equal(ledger.reservations.length, 0);
});

test('unbound transient review failure releases its reservation and retries the same eligible identity', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-reservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const fixture = await createCheckoutFixture(project);
  const reviewerRuns = [];
  const builder = tdAgent({ id: 'fixture-builder', identity: 'builder-primary', identityAliases: ['builder-session'], roles: ['build'],
    behavior: async task => { await writeFile(path.join(task.workspace, 'candidate-note.md'), 'fixture candidate\n'); return { id: task.runKey, result: Promise.resolve({ summary: 'built' }), dispose: async () => {} }; } });
  const reviewer = tdAgent({ id: 'independent-reviewer', identity: 'review-primary', identityAliases: ['review-session'], roles: ['review'], capabilities: ['review'],
    behavior: async task => {
      reviewerRuns.push(task.runKey);
      if (reviewerRuns.length === 1) throw new Error('transient reviewer failure');
      return { id: task.runKey, result: Promise.resolve({ verdict: 'reject', reason: 'fixture rejection', evidence: ['local fixture'], blockingRisks: ['fixture'] }), dispose: async () => {} };
    } });
  const runtime = new ProjectRuntime({ ...fixture, stateDir: path.join(root, 'state'), maxReviewAttempts: 3,
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
  }, { agents: [builder, reviewer], assessment: async () => ({ complete: false, reason: 'fixture action',
    gaps: [{ id: 'fixture-gap', description: 'Exercise review reservation release', priority: 1, evidence: ['test fixture'] }],
    candidates: [{ gapId: 'fixture-gap', goal: 'Create a fixture note', capabilities: ['code'], risk: 'normal', strategy: 'retry' }],
  }) });
  const state = await runtime.start({ maxActions: 1 });
  const action = state.actions[0];
  assert.equal(action.builder, builder.id, 'the Builder identity remains excluded from independent review');
  assert.equal(reviewerRuns.length, 2);
  assert.equal(action.reviewAttempts, 2);
  assert.equal(action.reviews[0].reviewer, reviewer.id);
  assert.deepEqual(action.reservedReviewerIds, [reviewer.id], 'only the bound completed reviewer reservation remains');
  assert.deepEqual(action.reservedReviewerIdentities, ['review-primary', 'review-session']);
});

test('restart releases a persisted reviewer reservation that has no bound report', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const fixture = await createCheckoutFixture(project);
  let reviewerStarts = 0;
  const builder = tdAgent({ id: 'restart-builder', identity: 'restart-builder-id', roles: ['build'], behavior: async () => { throw new Error('Builder must not run during review recovery'); } });
  const reviewer = tdAgent({ id: 'restart-reviewer', identity: 'restart-reviewer-id', identityAliases: ['restart-reviewer-alias'], roles: ['review'], capabilities: ['review'],
    behavior: async task => { reviewerStarts++; return { id: task.runKey, result: Promise.resolve({ verdict: 'pass', reason: 'recovered review', evidence: ['committed fixture'], blockingRisks: [] }), dispose: async () => {} }; } });
  const config = { ...fixture, stateDir, tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }], protectedPaths: ['tests/acceptance.test.mjs'] };
  const first = new ProjectRuntime(config, { agents: [builder, reviewer] });
  await first.initialize();
  const tree = await first.worktrees.create(randomUUID(), 'build', first.state.acceptedHead);
  await writeFile(path.join(tree.directory, 'restart-review-note.md'), 'committed candidate\n');
  const commit = await first.worktrees.commit(tree, 'persist review restart fixture');
  const snapshot = await first.worktrees.snapshot(tree.directory);
  const action = {
    id: randomUUID(), goal: 'Recover an unbound review reservation', risk: 'normal', builder: builder.id,
    builderIdentity: builder.identity, builderHistory: [builder.id], builderIdentities: [builder.identity],
    worktree: tree, acceptedBase: first.state.acceptedHead, commit, snapshot,
    diff: await first.worktrees.diff({ ...tree, base: first.state.acceptedHead }), actionDiff: await first.worktrees.diff(tree),
    tests: [{ passed: true }], committedTests: [{ passed: true }], protectedIntact: true,
    phase: 'REVIEWING', reviews: [], reservedReviewerIds: [reviewer.id], reservedReviewerIdentities: [reviewer.identity, ...reviewer.identityAliases],
  };
  first.state.actions.push(action);
  first.state.commits.push({ actionId: action.id, sha: commit, status: 'candidate' });
  await first.checkpoint();

  const restarted = new ProjectRuntime(config, { agents: [builder, reviewer] });
  await restarted.initialize();
  const recovered = restarted.state.actions.at(-1);
  await restarted.finishReview(recovered);

  assert.equal(reviewerStarts, 1, 'the previously reserved independent identity is eligible again after restart');
  assert.equal(recovered.phase, 'MERGE_READY');
  assert.equal(recovered.reviews[0].reviewer, reviewer.id);
  assert.deepEqual(recovered.reservedReviewerIds, [reviewer.id]);
  assert.deepEqual(recovered.reservedReviewerIdentities, ['restart-reviewer-id', 'restart-reviewer-alias']);
});

test('commercial alignment records the actual funded fallback reviewer and excludes Builder aliases', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-commercial-review-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const fixture = await createCheckoutFixture(project);
  const models = [
    { id: 'analysis-routine', provider: 'opencode', connectionId: 'analysis', tier: 'routine' },
    { id: 'paid-review-routine', provider: 'opencode', connectionId: 'paid-audit', tier: 'routine', paid: true, endpoint: EXAMPLE_ENDPOINT },
    { id: 'funded-audit-deep', provider: 'opencode', connectionId: 'funded-audit', tier: 'deep' },
    { id: 'builder-alias-audit', provider: 'opencode', connectionId: 'builder-alias-audit', tier: 'deep' },
    { id: 'builder-audit-model', provider: 'opencode', connectionId: 'builder-connection', tier: 'deep' },
  ];
  await createPaidApiGrant(stateDir, {
    project, connectionId: 'paid-audit', models: ['paid-review-routine'], endpoint: EXAMPLE_ENDPOINT,
    expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 2,
  });
  let paidStarts = 0;
  let fundedStarts = 0;
  let builderAliasStarts = 0;
  const analysis = tdAgent({ id: 'analysis-worker', provider: 'opencode', connectionId: 'analysis', roles: ['decide'], capabilities: ['reason'], behavior: async task => ({ id: task.runKey, result: Promise.resolve({ text: 'Host fixture analysis with evidence.' }), dispose: async () => {} }) });
  const builder = tdAgent({ id: 'commercial-builder', identity: 'commercial-builder-identity', identityAliases: ['commercial-builder-alias'], provider: 'opencode', connectionId: 'builder-connection', roles: ['build', 'review'], capabilities: ['code', 'review'], behavior: async () => { throw new Error('Builder alias must not audit commercial alignment'); } });
  const paidReviewer = tdAgent({ id: 'paid-auditor', identity: 'paid-auditor-identity', provider: 'opencode', connectionId: 'paid-audit', paidApi: { endpoint: EXAMPLE_ENDPOINT }, openCodeProvider: { id: 'paid-audit-provider', name: 'Paid audit fixture', baseURL: EXAMPLE_ENDPOINT }, roles: ['review'], capabilities: ['review'], trust: 1,
    behavior: async task => { paidStarts++; return { id: task.runKey, result: Promise.resolve({ outcome: 'PASS', reason: 'unexpected paid audit', evidence: ['fixture'], blockers: [] }), dispose: async () => {} }; } });
  const builderAliasReviewer = tdAgent({ id: 'commercial-builder-alias-worker', identity: 'commercial-builder-alias', provider: 'opencode', connectionId: 'builder-alias-audit', roles: ['review'], capabilities: ['review'], trust: 0.95,
    behavior: async task => { builderAliasStarts++; return { id: task.runKey, result: Promise.resolve({ outcome: 'PASS', reason: 'Builder alias must not audit', evidence: ['fixture'], blockers: [] }), dispose: async () => {} }; } });
  const fundedReviewer = tdAgent({ id: 'funded-auditor', identity: 'funded-auditor-identity', provider: 'opencode', connectionId: 'funded-audit', roles: ['review'], capabilities: ['review'], trust: 0.6,
    behavior: async task => { fundedStarts++; return { id: task.runKey, result: Promise.resolve({ outcome: 'PASS', reason: 'Funded audit passed', evidence: ['local deterministic audit'], blockers: [] }), dispose: async () => {} }; } });
  const runtime = new ProjectRuntime({
    ...fixture, stateDir, models,
    tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }],
    protectedPaths: ['tests/acceptance.test.mjs'],
    commercialLoop: { enabled: true, worker: 'analysis-worker', references: [{ url: 'https://example.test/benchmark', text: 'Verified local benchmark fixture.' }] },
  }, { agents: [analysis, builder, paidReviewer, builderAliasReviewer, fundedReviewer] });
  await runtime.initialize();
  const tree = await runtime.worktrees.create(randomUUID(), 'observe', runtime.state.acceptedHead);
  const action = { id: randomUUID(), goal: 'High-risk fixture action', risk: 'high', builder: builder.id, builderIdentity: builder.identity,
    builderHistory: [builder.id], builderIdentities: [builder.identity, ...builder.identityAliases], phase: 'BUILDING' };
  const record = await runtime.commercial.stage('verify', { snapshot: { hash: 'fixture-snapshot' }, tests: [] }, tree, action);

  assert.equal(record.worker, analysis.id);
  assert.equal(record.reviewer, fundedReviewer.id, 'audit provenance records the actor actually selected after model-aware fallback');
  assert.equal(record.reviewerConnectionId, 'funded-audit');
  assert.equal(paidStarts, 0, 'routine-only paid connection is rejected before Worker start');
  assert.equal(builderAliasStarts, 0, 'commercial audit excludes identity aliases across adapters before Worker preparation');
  assert.equal(fundedStarts, 1);
  const ledger = JSON.parse(await readFile(path.join(stateDir, 'paid-api', 'ledger.json'), 'utf8'));
  assert.equal(ledger.grants[0].consumedWorkerRuns, 0);
  assert.equal(ledger.reservations.length, 0);
});
