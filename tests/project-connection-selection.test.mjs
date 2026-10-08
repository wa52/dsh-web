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
    assert.equal(runtime.paidModelEligibility.size, 0, 'paid connection has no implicit authorization grant');
  };
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
