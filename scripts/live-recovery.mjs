import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { repairHarness } from '../runtime/recovery.mjs';
import { atomicJson } from '../runtime/store.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/live-recovery.mjs config.local.json');
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = path.resolve('.tmp', `live-recovery-${randomUUID()}`);
const repository = path.join(root, 'harness');
await mkdir(repository, { recursive: true });
await writeFile(path.join(repository, 'harness.mjs'), 'throw new Error("HARNESS_STARTUP_FAILURE");\n');
await writeFile(path.join(repository, 'harness.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process'; test('Harness boots and reports ready', () => { const run = spawnSync(process.execPath, ['harness.mjs'], { encoding: 'utf8' }); assert.equal(run.status, 0); assert.match(run.stdout, /ready/); });\n`);
const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
git(['init', '-b', 'main']); git(['add', '.']); git(['-c', 'user.name=Recovery fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Broken Harness startup fixture']);
const report = await repairHarness({ stateDir: path.join(root, 'state'), failure: 'HARNESS_STARTUP_FAILURE: harness.mjs throws on boot; it must exit successfully and print ready. Do not alter harness.test.mjs.', recovery: {
  enabled: true, repository, codex: options.agents.codex, protectedPaths: ['harness.test.mjs'], tests: [{ executable: process.execPath, args: ['--test', 'harness.test.mjs'] }],
} });
const protectedTest = (await execFileSync('git', ['-C', repository, 'show', 'HEAD:harness.test.mjs'], { encoding: 'utf8' })).trim();
const passed = report.status === 'merge-ready' && (await readFile(path.join(report.tree.directory, 'harness.test.mjs'), 'utf8')).trim() === protectedTest;
await atomicJson(path.join(root, 'acceptance.json'), { status: passed ? 'PASS' : 'FAIL', ...report });
console.log(JSON.stringify({ status: passed ? 'PASS' : 'FAIL', commit: report.commit, report: path.join(root, 'acceptance.json') }, null, 2));
if (!passed) process.exitCode = 1;
