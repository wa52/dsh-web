import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function bounded(promise, ms, label, signal) {
  let timer;
  let onAbort;
  try {
    const candidates = [promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })];
    if (signal) candidates.push(new Promise((_, reject) => {
      onAbort = () => reject(new Error(`${label} aborted`));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }));
    return await Promise.race(candidates);
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** Host-owned governance loop. Never expose this object as a Builder tool. */
export class AutonomousControlLoop {
  constructor({ stateDir, workspace, snapshot, decide, routeReview, timeoutMs = 300_000, stopTimeoutMs = 30_000 }) {
    if (!path.isAbsolute(stateDir) || !path.isAbsolute(workspace)) throw new Error('Absolute stateDir and workspace required');
    if (![timeoutMs, stopTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647)) throw new Error('Invalid timeout');
    for (const fn of [snapshot, decide, routeReview]) if (typeof fn !== 'function') throw new Error('Host snapshot, decide and routeReview functions required');
    Object.assign(this, { stateDir, workspace, snapshot, decide, routeReview, timeoutMs, stopTimeoutMs });
    this.workers = new Map();
    this.active = false;
    this.closed = false;
    this.abort = undefined;
    this.idle = Promise.resolve();
  }

  registerWorker(worker) {
    if (!worker.id || !worker.identity || !Array.isArray(worker.roles) || typeof worker.start !== 'function') throw new Error('Invalid worker');
    if (this.workers.has(worker.id)) throw new Error(`Duplicate worker: ${worker.id}`);
    this.workers.set(worker.id, Object.freeze({ ...worker, roles: Object.freeze([...worker.roles]) }));
    return () => this.workers.delete(worker.id);
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(path.join(this.stateDir, 'world-state.json'), 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.actions) || state.workspace !== await realpath(this.workspace)) throw new Error('Incompatible world state');
      const phases = ['BUILDING', 'REVIEW_REQUIRED', 'REVIEWING', 'ACCEPTED', 'REJECTED', 'HALTED'];
      if (!Array.isArray(state.evidence) || !Number.isSafeInteger(state.revision) || state.actions.some(a => !phases.includes(a.phase))) throw new Error('Invalid world state');
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, workspace: await realpath(this.workspace), actions: [], evidence: [], revision: 0 };
    }
  }

  async persist(state) {
    state.revision++;
    const target = path.join(this.stateDir, 'world-state.json');
    const temp = `${target}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx');
    try { await file.writeFile(JSON.stringify(state, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, target);
  }

  async inspect() {
    const value = await this.snapshot(this.workspace);
    // Snapshot must cover tracked edits, staged edits, deletions AND untracked files.
    return { evidence: copy(value), hash: digest(value) };
  }

  /** Bounded host scheduler; each iteration re-decides from persisted world state. */
  async run({ maxActions = 1, signal } = {}) {
    if (!Number.isSafeInteger(maxActions) || maxActions < 1) throw new Error('Positive maxActions required');
    const onAbort = () => { this.closed = true; this.abort?.abort(); };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let state;
      for (let round = 0; round < maxActions; round++) {
        const before = await this.readState();
        state = await this.tick();
        if (state.revision === before.revision) break;
        if (state.actions.at(-1)?.phase === 'REJECTED') break;
      }
      return state;
    } finally { signal?.removeEventListener('abort', onAbort); }
  }

  worker(id, role) {
    const worker = this.workers.get(id);
    if (!worker?.roles.includes(role)) throw new Error(`Worker ${id} cannot perform ${role}`);
    if (role === 'review' && worker.readOnly !== true) throw new Error('Reviewer requires enforced read-only isolation');
    return worker;
  }

  async execute(worker, request) {
    const abort = new AbortController();
    this.abort = abort;
    let run;
    let published;
    let abandoned = false;
    const starting = Promise.resolve().then(() => worker.start({ ...copy(request), signal: abort.signal }));
    // If publication arrives after timeout, still dispose it; the action stays HALTED.
    starting.then(late => {
      published = late;
      if (abandoned) Promise.resolve().then(() => late.dispose()).catch(() => {});
    }, () => {});
    try {
      run = await bounded(starting, this.timeoutMs, 'Worker startup', abort.signal);
      if (!run || typeof run.dispose !== 'function' || !run.result) throw new Error('Invalid worker run');
      if (this.closed) throw new Error('Controller closed');
      return await bounded(Promise.resolve(run.result), this.timeoutMs, 'Worker result', abort.signal);
    } catch (error) {
      if (!run) error.unsafeStop = true;
      throw error;
    } finally {
      abandoned = true;
      abort.abort();
      run ??= published;
      if (run) {
        try { await bounded(Promise.resolve().then(() => run.dispose()), this.stopTimeoutMs, 'Worker stop'); }
        catch (error) { error.unsafeStop = true; throw error; }
      }
      this.abort = undefined;
    }
  }

  /** One governed action per call. A host may repeatedly call tick; Workers cannot. */
  async tick() {
    if (this.closed || this.active) throw new Error('Controller closed or already running');
    this.active = true;
    let resolveIdle;
    this.idle = new Promise(resolve => { resolveIdle = resolve; });
    let lock;
    try {
      await mkdir(this.stateDir, { recursive: true });
      const stateRoot = await realpath(this.stateDir);
      const projectRoot = await realpath(this.workspace);
      const relative = path.relative(projectRoot, stateRoot);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('stateDir must be outside workspace');
      lock = await open(path.join(this.stateDir, 'controller.lock'), 'wx');
      await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
      const state = await this.readState();
      let action = state.actions.at(-1);
      if (action?.phase === 'BUILDING') {
        action.phase = 'HALTED';
        action.error = 'Interrupted build: host must confirm all workers stopped before recovery';
        await this.persist(state);
      }
      if (action?.phase === 'HALTED') throw new Error(action.error);
      if (action && ['REVIEW_REQUIRED', 'REVIEWING'].includes(action.phase)) return await this.review(state, action);

      const decision = await this.decide(copy(state), await this.inspect());
      if (!decision) return copy(state);
      if (this.closed) throw new Error('Controller closed');
      if (typeof decision.goal !== 'string' || !decision.goal.trim() || typeof decision.workerId !== 'string') throw new Error('Action requires goal and workerId');
      if (action?.phase === 'REJECTED' && decision.repairOf !== action.id) throw new Error('Rejected action requires an explicit repair action');
      const builder = this.worker(decision.workerId, 'build');
      action = { id: randomUUID(), goal: decision.goal, repairOf: decision.repairOf, builder: builder.id, builderIdentity: builder.identity, phase: 'BUILDING', baseline: await this.inspect(), reviews: [] };
      state.actions.push(action);
      await this.persist(state);
      try {
        action.result = copy(await this.execute(builder, { role: 'build', actionId: action.id, goal: action.goal, workspace: this.workspace }));
        action.snapshot = await this.inspect();
        action.changed = action.baseline.hash !== action.snapshot.hash;
        // Even no-diff actions go through review: failure/no-op must not silently count as success.
        action.phase = 'REVIEW_REQUIRED';
        await this.persist(state);
      } catch (error) {
        action.phase = 'HALTED'; action.error = error.message;
        await this.persist(state);
        throw error;
      }
      return await this.review(state, action);
    } finally {
      try {
        if (lock) { await lock.close(); await unlink(path.join(this.stateDir, 'controller.lock')); }
      } finally { this.active = false; resolveIdle(); }
    }
  }

  async review(state, action) {
    try {
      if (this.closed) throw new Error('Controller closed');
      if ((await this.inspect()).hash !== action.snapshot.hash) throw new Error('Workspace changed since frozen review snapshot');
      const ids = await this.routeReview(copy(action), copy(state));
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('At least one unique reviewer required');
      const reviewers = ids.map(id => this.worker(id, 'review'));
      if (new Set(reviewers.map(r => r.identity)).size !== reviewers.length) throw new Error('Reviewers must have independent identities');
      for (const reviewer of reviewers) {
        if (reviewer.identity === action.builderIdentity) throw new Error('Reviewer must be independent of Builder');
      }
      action.phase = 'REVIEWING';
      action.reviews = [];
      await this.persist(state);
      for (const reviewer of reviewers) {
        const report = await this.execute(reviewer, { role: 'review', actionId: action.id, goal: action.goal, workspace: this.workspace, snapshot: action.snapshot, builderResult: action.result });
        if (!report || !['pass', 'reject'].includes(report.verdict) || report.snapshotHash !== action.snapshot.hash || !Array.isArray(report.evidence) || !report.evidence.length || report.evidence.some(e => typeof e !== 'string' || !e.trim())) throw new Error('Invalid review: verdict, snapshotHash and evidence required');
        if ((await this.inspect()).hash !== action.snapshot.hash) throw new Error('Workspace changed during review');
        action.reviews.push({ ...copy(report), reviewer: reviewer.id, identity: reviewer.identity });
        await this.persist(state);
      }
      action.phase = action.reviews.every(r => r.verdict === 'pass') ? 'ACCEPTED' : 'REJECTED';
      delete action.error;
      state.evidence.push({ actionId: action.id, snapshotHash: action.snapshot.hash, phase: action.phase, reviews: copy(action.reviews) });
      await this.persist(state);
      return copy(state);
    } catch (error) {
      // Stop errors and source mutations require host intervention, not another Builder.
      const unchanged = (await this.inspect()).hash === action.snapshot.hash;
      action.phase = unchanged && !error.unsafeStop ? 'REVIEW_REQUIRED' : 'HALTED';
      action.error = error.message;
      await this.persist(state);
      throw error;
    }
  }

  async close() {
    this.closed = true;
    this.abort?.abort();
    await this.idle;
  }
}
