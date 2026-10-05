import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBriefFixture, newProjectConfig } from '../scripts/fixture.mjs';

const acceptance = fileURLToPath(new URL('../scripts/new-project-acceptance.mjs', import.meta.url));
// Mirror runtime/process.mjs: an inherited NODE_TEST_CONTEXT can make a spawned
// Node child report success even when it fails, so remove it for Host commands.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-new-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  const seed = await createBriefFixture(repository);
  return { root, repository, seed };
}

test('brief fixture seeds a product brief with an initial commit and no application source', async t => {
  const { repository } = await fixture(t);
  const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  assert.deepEqual(git(['ls-files']).split('\n').sort(), ['README.md', 'package.json']);
  assert.equal(git(['rev-list', '--count', 'HEAD']), '1');
  assert.equal(git(['status', '--porcelain']), '');
  assert.match(await readFile(path.join(repository, 'README.md'), 'utf8'), /Product brief/);
  await assert.rejects(readFile(path.join(repository, 'pricing.mjs')), { code: 'ENOENT' });
});

test('external Host acceptance fails against the bare brief before any construction', async t => {
  const { repository } = await fixture(t);
  const run = spawnSync(process.execPath, [acceptance], { cwd: repository, encoding: 'utf8', windowsHide: true, env: childEnv });
  assert.notEqual(run.status, 0);
});

test('new-project config wires external Host acceptance, a verified Host reference and the protected brief', async t => {
  const { root, repository, seed } = await fixture(t);
  const config = newProjectConfig(seed, { root, acceptance, options: { permissions: { shell: false, network: false }, maxActions: 3 } });
  assert.equal(config.repository, repository);
  assert.equal(config.commercialLoop.enabled, true);
  assert.equal(config.commercialLoop.worker, 'opencode');
  assert.deepEqual(config.tests, [{ executable: process.execPath, args: [acceptance] }]);
  const relation = path.relative(repository, acceptance);
  assert.ok(relation.startsWith('..') || path.isAbsolute(relation), 'Host acceptance must live outside the product repository');
  assert.deepEqual(config.protectedPaths, ['README.md']);
  assert.equal(config.permissions.shell, false);
  assert.equal(config.permissions.network, false);
  assert.equal(config.maxActions, 3);
  const [reference] = config.commercialLoop.references;
  assert.match(reference.url, /^https:\/\//);
  assert.ok(reference.text.trim().length > 0);
});
