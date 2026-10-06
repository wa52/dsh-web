import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { routeModel, unavailableAgentIds, RoutingError } from '../runtime/routing.mjs';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';
import { createPaidApiGrant, revokePaidApiGrant, reservePaidApiRun, eligiblePaidConnections, assertPaidApiRunAuthorization, hasPaidApiRunAuthorization } from '../runtime/paid-authorization.mjs';

const EXAMPLE_ENDPOINT = 'https://api.example.com';

function tdAgent({ id, provider = 'test-double', connectionId, quotaGroup, paidApi, openCodeProvider, model, roles = ['build'], behavior }) {
  return {
    id,
    identity: `${id}-identity`,
    provider,
    ...(connectionId ? { connectionId } : {}),
    ...(quotaGroup ? { quotaGroup } : {}),
    ...(paidApi ? { paidApi } : {}),
    ...(openCodeProvider ? { openCodeProvider } : {}),
    ...(model ? { model } : {}),
    roles,
    capabilities: ['code', 'reason', 'review'],
    availability: 'online',
    trust: 0.8,
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
  const catalog = [
    { id: 'deepseek-v4.1-flash', provider: 'opencode', connectionId: 'opencode-go', tier: 'routine' },
    { id: 'account-model', provider: 'opencode', connectionId: 'opencode-subscription', tier: 'routine' },
  ];
  assert.equal(routeModel({ provider: 'opencode', connectionId: 'opencode-subscription' }, catalog).selectedModel, 'account-model');
  assert.throws(() => routeModel({ provider: 'opencode', connectionId: 'opencode-go' }, catalog), err => err instanceof RoutingError && err.code === 'NO_ELIGIBLE_MODEL');
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
  assert.ok(hasPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, runId: 'run-1' }));
  assert.ok(hasPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, runId: 'run-1' }), 'has check is non-consuming');
  assertPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, runId: 'run-1' });
  assert.ok(!hasPaidApiRunAuthorization(r1, { connectionId: 'deepseek-api', modelId: 'deepseek-flash', endpoint: EXAMPLE_ENDPOINT, runId: 'run-1' }), 'capability is consumed once');

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

  await t.test('forged or mismatched authorization capability is rejected', async () => {
    const g = await createPaidApiGrant(stateDir, {
      project, connectionId: 'forged-api', models: ['forged-model'], endpoint: EXAMPLE_ENDPOINT,
      expiresAt: '2099-01-01T00:00:00Z', maxWorkerRuns: 1,
    });
    const r = await reservePaidApiRun({ stateDir, connectionId: 'forged-api', modelId: 'forged-model', endpoint: EXAMPLE_ENDPOINT, project, runId: 'forged-run' });
    await assert.rejects(() => assertPaidApiRunAuthorization(r, { connectionId: 'forged-api', modelId: 'forged-model', endpoint: EXAMPLE_ENDPOINT, runId: 'wrong-run' }), /Paid API authorization needed/);
    await assert.rejects(() => assertPaidApiRunAuthorization({}, { connectionId: 'forged-api', modelId: 'forged-model', endpoint: EXAMPLE_ENDPOINT, runId: 'forged-run' }), /Paid API authorization needed/);
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
      assert.ok(hasPaidApiRunAuthorization(task.paidApiAuthorization, { connectionId: 'glm-api', modelId: 'glm-5.3-flash', endpoint: GLM_ENDPOINT, runId: task.runKey }));
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

test('read-only custom provider config preserves Host permission and tool fences', async () => {
  process.env.DEEPSEEK_API_KEY = 'fake-key-do-not-leak';
  try {
    const adapter = createAgentAdapter('opencode', {
      id: 'deepseekApi', connectionId: 'deepseek-api', model: 'deepseek-flash', roles: ['review'],
      paidApi: { endpoint: EXAMPLE_ENDPOINT },
      openCodeProvider: { id: 'deepseek-paid', name: 'DeepSeek V4.1 Flash (Paid API)', baseURL: EXAMPLE_ENDPOINT, apiKeyEnv: 'DEEPSEEK_API_KEY', modelName: 'DeepSeek V4.1 Flash' },
    });
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
