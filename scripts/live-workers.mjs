import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { atomicJson } from '../runtime/store.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/live-workers.mjs config.local.json [provider]');
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = path.resolve('.tmp', `live-workers-${randomUUID()}`);
await mkdir(root, { recursive: true });
const reports = [];
for (const provider of process.argv[3] ? [process.argv[3]] : ['codex', 'opencode', 'pi', 'dsh']) {
  const repository = path.join(root, provider, 'repo');
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, 'value.mjs'), 'export const answer = 1;\n');
  await writeFile(path.join(repository, 'acceptance.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { answer } from './value.mjs'; test('answer is two',()=>assert.equal(answer,2));\n");
  const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-b', 'main']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Write transport fixture']);
  const baseline = git(['rev-parse', 'HEAD']);
  const reviewer = provider === 'codex' ? 'dsh' : 'codex';
  const agents = [createAgentAdapter(provider, { ...options.agents[provider], roles: ['build'] }), createAgentAdapter(reviewer, { ...options.agents[reviewer], roles: ['review'] })];
  const runtime = new ProjectRuntime({ repository, stateDir: path.join(root, provider, 'state'), goal: 'Export answer=2 from value.mjs', successCriteria: ['The protected acceptance test passes'], permissions: { read: true, write: true, shell: false, network: false }, protectedPaths: ['acceptance.test.mjs'], tests: [{ executable: process.execPath, args: ['--test', 'acceptance.test.mjs'] }], agentTimeoutMs: 180000 }, { agents,
    // Transport acceptance, deliberately not an autonomous-decision benchmark.
    assessment: () => ({ complete: false, reason: 'Write transport test', gaps: [{ id: 'answer', description: 'answer should be two', priority: 1, evidence: ['value.mjs'] }], candidates: [{ gapId: 'answer', goal: 'Change only value.mjs to export answer=2. Return JSON summary and filesChanged.', capabilities: ['code'], risk: 'normal', strategy: 'repair' }] }),
  });
  let error;
  try { await runtime.start({ maxActions: 1 }); } catch (failure) { error = failure.message; }
  await runtime.close();
  const action = runtime.state.actions.at(-1);
  reports.push({ provider, reviewer, status: action?.phase === 'MERGE_READY' && git(['rev-parse', 'HEAD']) === baseline ? 'PASS' : 'FAIL', phase: action?.phase, commit: action?.commit, testsPassed: action?.tests?.every(test => test.passed), protectedIntact: action?.protectedIntact, review: action?.reviews?.map(r => ({ reviewer: r.reviewer, verdict: r.verdict })), error: error ?? action?.error });
  console.log(JSON.stringify(reports.at(-1)));
}
const report = { scenario: 'Real native write transports, host test, independent reviewer, main unchanged; not autonomous decision E2E', reports };
await atomicJson(path.join(root, 'acceptance.json'), report);
console.log(`Report: ${path.join(root, 'acceptance.json')}`);
if (reports.some(r => r.status !== 'PASS')) process.exitCode = 1;
