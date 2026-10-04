import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AutonomousControlLoop } from '../plugins/autonomous-control-loop/controller.js';
import { createDshWorker } from '../plugins/autonomous-control-loop/dsh-worker.js';
import { gitSnapshot } from '../plugins/autonomous-control-loop/git-snapshot.js';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../plugins/autonomous-control-loop/index.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'before');
  const settings = {
    workspace, stateDir: path.join(root, 'state'), timeoutMs: 200, stopTimeoutMs: 100,
    snapshot: async () => ({ source: await readFile(path.join(workspace, 'source.txt'), 'utf8') }),
    decide: async () => ({ goal: 'Fix source', workerId: 'builder' }),
    routeReview: async () => ['reviewer'], ...options,
  };
  const log = [];
  const loop = new AutonomousControlLoop(settings);
  loop.registerWorker({ id: 'builder', identity: 'build-session', roles: ['build'], start: async () => {
    log.push('build');
    await writeFile(path.join(workspace, 'source.txt'), 'after');
    return { result: Promise.resolve({ tests: 'pass' }), dispose: async () => { log.push('builder-stopped'); } };
  } });
  const review = (overrides = {}) => ({ id: 'reviewer', identity: 'review-session', roles: ['review'], readOnly: true,
    start: async input => {
      log.push('review');
      assert.ok(log.includes('builder-stopped'));
      return { result: Promise.resolve({ verdict: 'pass', snapshotHash: input.snapshot.hash, evidence: ['source and tests inspected'] }), dispose: async () => { log.push('reviewer-stopped'); } };
    }, ...overrides });
  loop.registerWorker(review());
  return { loop, root, workspace, settings, log, review };
}

test('builder stops before mandatory review; one tick runs only one action', async t => {
  const { loop, log } = await fixture(t);
  const state = await loop.tick();
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].phase, 'ACCEPTED');
  assert.deepEqual(log, ['build', 'builder-stopped', 'review', 'reviewer-stopped']);
  assert.equal(state.evidence.length, 1);
});

test('review rejection blocks unrelated build, permits explicit repair', async t => {
  const f = await fixture(t);
  f.loop.workers.set('reviewer', f.review({ start: async input => ({ result: Promise.resolve({ verdict: 'reject', snapshotHash: input.snapshot.hash, evidence: ['regression'] }), dispose: async () => {} }) }));
  const state = await f.loop.tick();
  assert.equal(state.actions[0].phase, 'REJECTED');
  await assert.rejects(f.loop.tick(), /explicit repair/);
  assert.equal(f.log.filter(v => v === 'build').length, 1);
  f.loop.decide = async () => ({ goal: 'Repair regression', workerId: 'builder', repairOf: state.actions[0].id });
  assert.equal((await f.loop.tick()).actions.length, 2);
});

test('missing reviewer does not bypass gate; restart retries review only', async t => {
  const f = await fixture(t, { routeReview: async () => [] });
  await assert.rejects(f.loop.tick(), /reviewer required/);
  assert.equal((await f.loop.readState()).actions[0].phase, 'REVIEW_REQUIRED');
  const resumed = new AutonomousControlLoop({ ...f.settings, routeReview: async () => ['reviewer'] });
  resumed.registerWorker(f.review());
  assert.equal((await resumed.tick()).actions[0].phase, 'ACCEPTED');
  assert.equal(f.log.filter(v => v === 'build').length, 1);
});

test('same identity and unenforced readonly reviewer are rejected', async t => {
  const f = await fixture(t);
  f.loop.workers.set('reviewer', f.review({ identity: 'build-session' }));
  await assert.rejects(f.loop.tick(), /independent/);
  f.loop.workers.set('reviewer', f.review({ readOnly: false }));
  await assert.rejects(f.loop.tick(), /read-only/);
});

test('stale report cannot accept snapshot', async t => {
  const f = await fixture(t);
  f.loop.workers.set('reviewer', f.review({ start: async () => ({ result: Promise.resolve({ verdict: 'pass', snapshotHash: 'stale', evidence: ['test'] }), dispose: async () => {} }) }));
  await assert.rejects(f.loop.tick(), /Invalid review/);
  assert.equal((await f.loop.readState()).actions[0].phase, 'REVIEW_REQUIRED');
});

test('mutation during review halts control loop', async t => {
  const f = await fixture(t);
  f.loop.workers.set('reviewer', f.review({ start: async input => {
    await writeFile(path.join(f.workspace, 'source.txt'), 'unexpected');
    return { result: Promise.resolve({ verdict: 'pass', snapshotHash: input.snapshot.hash, evidence: ['test'] }), dispose: async () => {} };
  } }));
  await assert.rejects(f.loop.tick(), /changed during review/);
  assert.equal((await f.loop.readState()).actions[0].phase, 'HALTED');
  await assert.rejects(f.loop.tick(), /changed during review/);
});

test('failed stop prevents review and remains halted after restart', async t => {
  const f = await fixture(t, { stopTimeoutMs: 20 });
  f.loop.workers.set('builder', { id: 'builder', identity: 'build-session', roles: ['build'], start: async () => ({ result: Promise.resolve({}), dispose: () => new Promise(() => {}) }) });
  await assert.rejects(f.loop.tick(), /Worker stop timed out/);
  assert.ok(!f.log.includes('review'));
  const resumed = new AutonomousControlLoop(f.settings);
  await assert.rejects(resumed.tick(), /Worker stop timed out/);
});

test('startup timeout cannot be retried as ordinary review', async t => {
  const f = await fixture(t, { timeoutMs: 20 });
  f.loop.workers.set('reviewer', f.review({ start: () => new Promise(() => {}) }));
  await assert.rejects(f.loop.tick(), /startup timed out/);
  assert.equal((await f.loop.readState()).actions[0].phase, 'HALTED');
});

test('crash in BUILDING does not dispatch another worker', async t => {
  const f = await fixture(t);
  await mkdir(f.settings.stateDir);
  const state = await f.loop.readState();
  state.actions.push({ id: 'interrupted', phase: 'BUILDING' });
  await f.loop.persist(state);
  await assert.rejects(f.loop.tick(), /Interrupted build/);
  assert.deepEqual(f.log, []);
});

test('exclusive state lock blocks concurrent controller', async t => {
  const f = await fixture(t);
  let release;
  f.loop.decide = () => new Promise(resolve => { release = resolve; });
  const running = f.loop.tick();
  while (!release) await new Promise(resolve => setTimeout(resolve, 2));
  const other = new AutonomousControlLoop(f.settings);
  await assert.rejects(other.tick(), /EEXIST/);
  release(null);
  await running;
});

test('close cancels active worker and drains disposal', async t => {
  const f = await fixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let stopped = false;
  f.loop.workers.set('builder', { id: 'builder', identity: 'build-session', roles: ['build'], start: async () => {
    started();
    return { result: new Promise(() => {}), dispose: async () => { stopped = true; } };
  } });
  const running = f.loop.tick();
  const rejection = assert.rejects(running, /aborted|closed/);
  await ready;
  await f.loop.close();
  await rejection;
  assert.ok(stopped);
  await assert.rejects(f.loop.tick(), /closed/);
});

test('DSH bridge uses original published one-shot start/result/dispose contract', async () => {
  let request;
  let stopped = false;
  const worker = createDshWorker({ id: 'dsh', identity: 'dsh-builder', roles: ['build'], provider: 'spawn', parent: {}, subagents: {
    start: async (provider, input) => {
      assert.equal(provider, 'spawn'); request = input;
      return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => { stopped = true; } };
    },
  } });
  const run = await worker.start({ actionId: 'one', goal: 'Fix', workspace: '/project', signal: new AbortController().signal });
  assert.equal((await run.result).stopReason, 'completed');
  await run.dispose();
  assert.ok(stopped);
  assert.match(request.prompt[0].text, /only this action/);
  assert.throws(() => createDshWorker({ roles: ['review'], readOnly: true }), /read-only/);
});

test('Git snapshot detects untracked, staged, edited and deleted files', async t => {
  const f = await fixture(t);
  const git = args => execFileSync('git', ['-C', f.workspace, ...args], { stdio: 'pipe' });
  git(['init']);
  const first = await gitSnapshot(f.workspace);
  await writeFile(path.join(f.workspace, 'new.txt'), 'new');
  const second = await gitSnapshot(f.workspace);
  assert.notDeepEqual(first, second);
  git(['add', '.']);
  const staged = await gitSnapshot(f.workspace);
  assert.notEqual(staged.indexHash, second.indexHash);
  await writeFile(path.join(f.workspace, 'new.txt'), 'modified');
  assert.notDeepEqual(await gitSnapshot(f.workspace), staged);
  await unlink(path.join(f.workspace, 'new.txt'));
  assert.equal((await gitSnapshot(f.workspace)).files.find(f => f.name === 'new.txt').type, 'deleted');
});

test('Cordis plugin mounts host service without replacing original agent-loop', async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(plugin);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof ctx.autonomousControl.create, 'function');
  await fiber.dispose();
  assert.equal(ctx.autonomousControl, undefined);
});

test('outer run re-decides after acceptance and stops at decision exhaustion', async t => {
  const f = await fixture(t);
  const observations = [];
  f.loop.decide = async (state, observation) => {
    observations.push(observation.evidence.source);
    if (state.actions.length === 2) return null;
    if (state.actions.length) assert.equal(state.actions.at(-1).phase, 'ACCEPTED');
    return { goal: `Action ${state.actions.length + 1}`, workerId: 'builder' };
  };
  const state = await f.loop.run({ maxActions: 10 });
  assert.equal(state.actions.length, 2);
  assert.deepEqual(observations, ['before', 'after', 'after']);
  assert.equal(f.log.filter(v => v === 'review').length, 2);
});

test('every required reviewer must pass', async t => {
  const f = await fixture(t, { routeReview: async () => ['reviewer', 'security'] });
  f.loop.registerWorker(f.review({ id: 'security', identity: 'security-session', start: async input => ({
    result: Promise.resolve({ verdict: 'reject', snapshotHash: input.snapshot.hash, evidence: ['security regression'] }), dispose: async () => {},
  }) }));
  const state = await f.loop.run({ maxActions: 5 });
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].reviews.length, 2);
  assert.equal(state.actions[0].phase, 'REJECTED');
});

test('late worker publication after timeout is disposed without reopening gate', async t => {
  const f = await fixture(t, { timeoutMs: 10 });
  let stopped = false;
  f.loop.workers.set('builder', { id: 'builder', identity: 'build-session', roles: ['build'], start: async () => {
    await new Promise(resolve => setTimeout(resolve, 35));
    return { result: Promise.resolve({}), dispose: async () => { stopped = true; } };
  } });
  await assert.rejects(f.loop.tick(), /startup timed out/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(stopped);
  assert.equal((await f.loop.readState()).actions[0].phase, 'HALTED');
  assert.ok(!f.log.includes('review'));
});
