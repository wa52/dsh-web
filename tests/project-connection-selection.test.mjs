import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebHost } from '../runtime/host.mjs';
import { mergeAgentConfigs } from '../runtime/project-config.mjs';

const hostAgents = {
  first: { transport: 'opencode', executable: process.execPath, enabled: true, connectionId: 'funded-first', capabilities: ['code', 'reason'] },
  second: { transport: 'opencode', executable: process.execPath, enabled: true, connectionId: 'funded-second', capabilities: ['code', 'reason'] },
  disabled: { transport: 'codex', executable: process.execPath, enabled: false, connectionId: 'host-disabled', capabilities: ['code', 'reason'] },
  paid: { transport: 'opencode', executable: process.execPath, enabled: true, connectionId: 'paid-connection', paidApi: { endpoint: 'https://paid.invalid' }, openCodeProvider: { baseURL: 'https://paid.invalid' }, capabilities: ['code', 'reason'] },
};

test('empty/default selection inherits Host enabled connections; explicit selection is a strict subset', () => {
  assert.deepEqual(Object.keys(mergeAgentConfigs(undefined, hostAgents)), ['first', 'second', 'paid']);
  assert.deepEqual(Object.keys(mergeAgentConfigs({}, hostAgents)), ['first', 'second', 'paid']);
  assert.deepEqual(Object.keys(mergeAgentConfigs({ first: { enabled: true }, second: { enabled: false }, disabled: { enabled: true } }, hostAgents)), ['first']);
  assert.throws(() => mergeAgentConfigs({ unknown: { enabled: true } }, hostAgents), /Unknown Host connection alias/);
  assert.throws(() => mergeAgentConfigs({ paid: { enabled: 'yes' } }, hostAgents), /Invalid project selection/);
});

test('explicit subset filters runtime and trusted model catalog on setup and reload', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-project-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  await mkdir(repository);
  await writeFile(path.join(repository, 'package.json'), '{"type":"module"}\n');
  const git = (...args) => awaitImportGit(repository, args);
  await git('init', '-b', 'main'); await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'seed');
  const models = ['funded-first', 'funded-second', 'paid-connection'].map((connectionId, index) => ({ id: `model-${index}`, provider: 'opencode', connectionId, tier: 'routine', eligible: true, ...(connectionId === 'paid-connection' ? { paid: true, endpoint: 'https://paid.invalid' } : {}) }));
  const host = new WebHost({ stateDir, hostAgents, hostModels: models });
  t.after(() => host.close());
  await host.init();
  await host.setupProject({ goal: 'selection regression', repository, stateDir: path.join(root, 'project-state'), successCriteria: ['pass'], tests: [{ executable: process.execPath, args: ['--version'] }], agents: { first: { enabled: true } } });
  const activeRuntime = host.projectRuntime;
  await assert.rejects(host.setupProject({ goal: 'invalid selection', repository, stateDir: path.join(root, 'invalid-state'), successCriteria: ['pass'], tests: [{ executable: process.execPath, args: ['--version'] }], agents: { unknown: { enabled: true } } }), /Unknown Host connection alias/);
  assert.equal(host.projectRuntime, activeRuntime, 'invalid alias must not replace active runtime');
  assert.deepEqual(Object.keys(mergeAgentConfigs({ disabled: { enabled: true } }, hostAgents)), []);
  const verify = runtime => {
    assert.deepEqual([...runtime.registry.agents.keys()], ['first']);
    assert.deepEqual(runtime.config.models.map(model => model.connectionId), ['funded-first']);
    assert.equal(runtime.config.commercialLoop.worker, 'first');
    assert.equal(runtime.modelDecision.preferred(), 'first');
    assert.equal(runtime.registry.agents.has('second'), false, 'omitted enabled funded adapter cannot enter auto worker or decision candidates');
    assert.equal(runtime.config.models.some(model => model.connectionId === 'funded-second'), false);
    assert.equal(runtime.paidModelEligibility.size, 0, 'paid connection has no implicit authorization grant');
  };
  verify(host.projectRuntime);
  const restarted = new WebHost({ stateDir, hostAgents, hostModels: models });
  t.after(() => restarted.close());
  await restarted.init();
  verify(restarted.projectRuntime);
});

test('explicitly selected paid connection stays registered but unauthorized routing uses funded fallback after restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-project-selected-paid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  await mkdir(repository);
  await writeFile(path.join(repository, 'package.json'), '{"type":"module"}\n');
  const git = (...args) => awaitImportGit(repository, args);
  await git('init', '-b', 'main'); await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'seed');
  const models = [
    { id: 'funded-deep', provider: 'opencode', connectionId: 'funded-first', tier: 'deep', eligible: true },
    { id: 'paid-deep', provider: 'opencode', connectionId: 'paid-connection', tier: 'deep', eligible: true, paid: true, endpoint: 'https://paid.invalid' },
  ];
  const selectedAgents = { first: { enabled: true }, paid: { enabled: true } };
  const setup = {
    goal: 'selected paid connection remains unauthorized without grant', repository,
    stateDir: path.join(root, 'project-state'), successCriteria: ['funded fallback'],
    tests: [{ executable: process.execPath, args: ['--version'] }], agents: selectedAgents,
  };
  const verify = runtime => {
    const paid = runtime.registry.agents.get('paid');
    const funded = runtime.registry.agents.get('first');
    assert.ok(paid, 'explicitly selected paid Host connection remains registered');
    assert.ok(funded, 'funded fallback remains registered');
    assert.deepEqual(new Set(runtime.config.models.map(model => model.connectionId)), new Set(['funded-first', 'paid-connection']), 'matching Host metadata remains server-side');
    assert.equal(runtime.paidModelEligibility.size, 0, 'selection does not create a paid authorization grant');
    assert.throws(() => runtime.routeFor(paid, { role: 'build', risk: 'high' }), /Paid API authorization needed/);
    let paidWorkerStarts = 0;
    const originalStart = paid.start;
    paid.start = (...args) => { paidWorkerStarts++; return originalStart.apply(paid, args); };
    const resolved = runtime.resolveAgentForTask(paid, { role: 'build', risk: 'high', capabilities: ['code'] });
    assert.equal(resolved.agent.id, 'first', 'authorization denial routes to the funded fallback');
    assert.equal(resolved.routing.selectedModel, 'funded-deep');
    assert.equal(resolved.routing.connectionId, 'funded-first');
    assert.equal(paidWorkerStarts, 0, 'unauthorized paid worker cannot be prepared');
  };
  const host = new WebHost({ stateDir, hostAgents, hostModels: models });
  t.after(() => host.close());
  await host.init();
  await host.setupProject(setup);
  verify(host.projectRuntime);
  const restarted = new WebHost({ stateDir, hostAgents, hostModels: models });
  t.after(() => restarted.close());
  await restarted.init();
  verify(restarted.projectRuntime);
});

async function awaitImportGit(repository, args) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
}
