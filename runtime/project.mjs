import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorldStore, clone, atomicJson } from './store.mjs';
import { WorktreeManager, hash } from './worktrees.mjs';
import { AgentRegistry, updatePerformance } from './registry.mjs';
import { ModelDecision, REVIEW_SHAPE, validateAssessment } from './decision.mjs';
import { policyFor, guardPath } from './permissions.mjs';
import { runCommand, redact } from './process.mjs';

const safeError = error => redact(error instanceof Error ? error.message : String(error));

/** Project-level Loop hosted by DSH's control plugin, separate from its Agent loop. */
export class ProjectRuntime extends EventEmitter {
  constructor(config, { agents = [], assessment, observe, afterBuild } = {}) {
    super();
    if (!config.goal?.trim() || !Array.isArray(config.successCriteria) || !config.successCriteria.length || !config.repository || !config.stateDir || !Array.isArray(config.tests) || !config.tests.length) throw new Error('Goal, repository, stateDir, successCriteria and host-owned tests required');
    this.config = clone(config);
    this.repository = path.resolve(config.repository);
    this.store = new WorldStore(config.stateDir);
    this.id = hash(this.repository).slice(0, 12);
    this.worktrees = new WorktreeManager(this.repository, path.join(this.store.directory, 'worktrees'), this.id);
    this.registry = new AgentRegistry();
    agents.forEach(agent => this.registry.add(agent));
    this.assessment = assessment;
    this.observeExtra = observe;
    this.afterBuild = afterBuild;
    this.state = null;
    this.running = false;
    this.pauseRequested = false;
    this.controller = null;
    this.currentRun = null;
    this.persistence = Promise.resolve();
    this.modelDecision = new ModelDecision(this.execute.bind(this), this.registry, config.decisionAgent);
  }

  async initialize() {
    await this.store.assertOutside(this.repository);
    await this.worktrees.validate();
    const loaded = await this.store.load();
    const policyHash = hash({ tests: this.config.tests, protectedPaths: this.config.protectedPaths ?? [], constraints: this.config.constraints ?? [] });
    if (loaded) {
      if (loaded.project.repository !== this.repository || loaded.goal !== this.config.goal || hash(loaded.successCriteria) !== hash(this.config.successCriteria) || hash(loaded.permissions) !== hash(this.config.permissions ?? {})) throw new Error('Project configuration differs from persisted state; create a new stateDir');
      this.state = loaded;
      if (loaded.policyHash && loaded.policyHash !== policyHash) throw new Error('Host tests or constraints differ from persisted policy; create a new stateDir');
      if (!loaded.policyHash) { loaded.policyHash = policyHash; await this.checkpoint(); }
      return clone(loaded);
    }
    this.state = {
      version: 2, revision: 0, policyHash, project: { id: this.id, repository: this.repository }, goal: this.config.goal,
      constraints: this.config.constraints ?? [], successCriteria: this.config.successCriteria, permissions: this.config.permissions ?? {},
      acceptedHead: await this.worktrees.git(this.repository, ['rev-parse', 'HEAD']), currentState: {}, gaps: [],
      evidence: [], actions: [], reviews: [], failures: [], decisions: [], agentPerformance: {}, commits: [], runs: [],
      riskLevel: 'normal', projectHealth: 0, phase: 'STOP', status: 'idle', events: [],
    };
    // Initialization creates no Worker and cannot alter project source.
    await this.checkpoint();
    return clone(this.state);
  }

  checkpoint() {
    this.persistence = this.persistence.then(() => this.store.save(this.state));
    return this.persistence;
  }
  async event(phase, detail = {}) {
    this.state.phase = phase;
    const event = { seq: this.state.events.length + 1, at: new Date().toISOString(), phase, ...clone(detail) };
    this.state.events.push(event);
    await this.checkpoint();
    this.emit('state', this.view());
  }
  view() {
    const agents = this.registry.describe(this.state?.agentPerformance).map(agent => {
      const runs = new Map((this.state?.runs ?? []).filter(run => run.worker === agent.id).map(run => [run.id, clone(run)]));
      for (const run of agent.runs ?? []) runs.set(run.id, run);
      return { ...agent, runs: [...runs.values()].slice(-100) };
    });
    return { world: clone(this.state), agents, running: this.running };
  }

  async execute(agent, task) {
    const runKey = randomUUID();
    const artifactDir = path.join(this.store.directory, 'evidence', task.actionId ?? runKey);
    await mkdir(artifactDir, { recursive: true });
    const abort = new AbortController();
    this.controller = abort;
    const started = Date.now();
    const launchIntent = { id: runKey, launchToken: runKey, worker: agent.id, role: task.role, actionId: task.actionId, workspace: task.workspace, status: 'preparing', startedAt: new Date().toISOString() };
    this.state.runs.push(launchIntent);
    await this.checkpoint(); // Durable before any Worker is spawned.
    let run;
    try {
      run = await agent.start({ ...task, runKey, artifactDir, permissions: policyFor(task.role, this.state.permissions), timeoutMs: this.config.agentTimeoutMs ?? 300_000, signal: abort.signal, onEvent: event => {
        if (event.type === 'run-started') Object.assign(launchIntent, event, { role: task.role, actionId: task.actionId });
        this.emit('run', event);
      } });
      const resultPromise = Promise.resolve(run.result);
      resultPromise.catch(() => {});
      this.currentRun = { agent, run };
      await this.checkpoint();
      const result = await resultPromise;
      await run.dispose(); // Gate is unreachable until all descendants have stopped.
      const record = this.state.runs.find(record => record.id === run.id);
      if (record) Object.assign(record, { status: 'completed', result: clone(result), durationMs: Date.now() - started, stoppedAt: new Date().toISOString() });
      await this.checkpoint();
      return result;
    } catch (error) {
      if (run) {
        try { await run.dispose(); } catch (stopError) { throw new Error(`STOP_UNCONFIRMED: ${safeError(stopError)}`); }
        const record = this.state.runs.find(record => record.id === run.id);
        if (record) Object.assign(record, { status: 'failed', error: safeError(error), durationMs: Date.now() - started, stoppedAt: new Date().toISOString() });
      }
      else Object.assign(launchIntent, { status: 'failed', error: safeError(error), stoppedAt: new Date().toISOString() });
      await this.checkpoint();
      throw error;
    } finally { this.currentRun = null; this.controller = null; }
  }

  async tests(directory, actionId) {
    const artifactDir = path.join(this.store.directory, 'evidence', actionId);
    const reports = [];
    for (let i = 0; i < this.config.tests.length; i++) {
      reports.push(await runCommand(this.config.tests[i], directory, { artifactDir, name: `test-${i}`, timeoutMs: this.config.testTimeoutMs ?? 60_000 }));
    }
    await atomicJson(path.join(artifactDir, 'tests.json'), reports);
    return reports;
  }

  async observation() {
    await this.event('OBSERVE');
    const previous = this.state.actions.findLast(action => action.phase === 'REJECTED' && action.acceptedBase === this.state.acceptedHead && action.disposition !== 'abandoned');
    const observedHead = previous?.phase === 'REJECTED' ? previous.commit : this.state.acceptedHead;
    const tree = await this.worktrees.create(randomUUID(), 'observe', observedHead);
    const tests = await this.tests(tree.directory, `observe-${this.state.revision}`);
    const snapshot = await this.worktrees.snapshot(tree.directory);
    const sources = {};
    let remaining = this.config.sourceBudgetBytes ?? 120_000;
    for (const file of snapshot.evidence.files) {
      if (!remaining || file.type !== 'file' || !/\.(?:[cm]?[jt]sx?|py|cs|java|html|css|md|json)$/.test(file.name) || /(?:lock|credentials|auth|secret|\.local\.)/i.test(file.name) || guardPath(tree.directory, file.name)) continue;
      const content = await readFile(path.join(tree.directory, file.name), 'utf8');
      if (content.includes('\0')) continue;
      sources[file.name] = redact(content.slice(0, Math.min(remaining, 32_000)));
      remaining -= sources[file.name].length;
    }
    const extra = this.observeExtra ? await this.observeExtra(clone(this.state), tree.directory) : {};
    const observation = { ...clone(extra), at: new Date().toISOString(), head: observedHead, acceptedHead: this.state.acceptedHead, tests, snapshot, sources };
    this.state.evidence.push({ kind: 'observation', ...observation });
    return { observation, tree };
  }

  async decide(observation, tree) {
    await this.event('DECIDE');
    const assessment = this.assessment ? validateAssessment(await this.assessment(clone(this.state), clone(observation), tree.directory)) : await this.modelDecision.assess(this.state, observation, tree.directory);
    // Diagnostics never modify an accepted snapshot.
    if ((await this.worktrees.snapshot(tree.directory)).hash !== observation.snapshot.hash) throw new Error('Decision Agent changed observation worktree');
    const decision = { id: randomUUID(), at: new Date().toISOString(), basedOn: observation.head, observationHash: observation.snapshot.hash, decidedBy: assessment.decidedBy ?? 'host-policy', ...clone(assessment) };
    this.state.decisions.push(decision);
    this.state.gaps = clone(assessment.gaps);
    this.state.currentState = clone(assessment.currentState ?? {});
    this.state.projectHealth = Number.isFinite(assessment.projectHealth) ? Math.min(1, Math.max(0, assessment.projectHealth)) : 0;
    await this.checkpoint();
    if (assessment.complete) {
      if (!observation.tests.every(test => test.passed)) throw new Error('Completion rejected: required tests fail');
      if (observation.head !== this.state.acceptedHead) throw new Error('Completion rejected: candidate has not passed independent review');
      this.state.status = 'complete'; await this.event('STOP', { reason: assessment.reason }); return null;
    }
    const priorities = new Map(assessment.gaps.map(gap => [gap.id, gap.priority]));
    const candidates = assessment.candidates.toSorted((a, b) => priorities.get(b.gapId) - priorities.get(a.gapId));
    if (!candidates.length) throw new Error('Project incomplete but no executable candidate');
    const candidate = candidates[0];
    const previous = this.state.actions.at(-1);
    const exclude = previous?.phase === 'FAILED' && this.state.agentPerformance[previous.builder]?.consecutiveFailures >= 3 ? [previous.builder] : [];
    const builder = this.registry.select({ role: 'build', capabilities: candidate.capabilities, risk: candidate.risk, exclude }, this.state.agentPerformance);
    const selected = { ...candidate, workerId: builder.id, scoreInputs: clone(this.state.agentPerformance), reason: candidate.rationale ?? assessment.reason };
    decision.selected = selected;
    await this.checkpoint();
    return { decision, candidate: selected, builder };
  }

  async build(selected) {
    const { decision, candidate, builder } = selected;
    const previous = this.state.actions.findLast(action => action.phase === 'REJECTED' && action.acceptedBase === this.state.acceptedHead && action.disposition !== 'abandoned') ?? this.state.actions.at(-1);
    const repair = previous?.phase === 'REJECTED' && candidate.strategy !== 'replace';
    const base = repair ? previous.commit : this.state.acceptedHead;
    if (previous?.phase === 'REJECTED') previous.disposition = repair ? 'repair' : 'abandoned';
    const id = randomUUID();
    const tree = await this.worktrees.create(id, 'build', base);
    const action = { id, decisionId: decision.id, gapId: candidate.gapId, goal: candidate.goal, rationale: candidate.reason, strategy: candidate.strategy, risk: candidate.risk, builder: builder.id, builderIdentity: builder.identity ?? builder.id, worktree: tree, acceptedBase: this.state.acceptedHead, phase: 'BUILDING', reviews: [], startedAt: new Date().toISOString() };
    this.state.actions.push(action); this.state.riskLevel = action.risk;
    await this.event('DISPATCH', { actionId: id, worker: builder.id });
    const protectedBefore = await this.worktrees.protectedHashes(tree.directory, this.config.protectedPaths ?? []);
    await this.event('BUILD', { actionId: id });
    try {
      action.builderResult = await this.execute(builder, { role: 'build', actionId: id, workspace: tree.directory, prompt: `Goal: ${action.goal}\nProject goal: ${this.state.goal}\nCriteria: ${JSON.stringify(this.state.successCriteria)}\nDiagnosis: ${JSON.stringify(this.state.gaps)}\nCurrent source evidence: ${JSON.stringify(this.state.evidence.filter(e => e.kind === 'observation').at(-1)?.sources ?? {})}\nPrevious review findings: ${JSON.stringify(previous?.reviews ?? [])}\nProtected files must not be changed: ${JSON.stringify(this.config.protectedPaths ?? [])}. Modify source only. Host runs tests and commits after you stop.`, outputSchema: { summary: 'string', filesChanged: ['string'] } });
      if (this.afterBuild) {
        const evidence = await this.afterBuild(clone(action), tree.directory);
        if (evidence) this.state.evidence.push({ kind: 'environment-event', actionId: id, ...clone(evidence) });
      }
      action.protectedIntact = hash(protectedBefore) === hash(await this.worktrees.protectedHashes(tree.directory, this.config.protectedPaths ?? []));
      action.tests = await this.tests(tree.directory, id);
      action.commit = await this.worktrees.commit(tree, `DSH action ${id}: ${action.goal}`);
      action.snapshot = await this.worktrees.snapshot(tree.directory);
      action.diff = await this.worktrees.diff({ ...tree, base: action.acceptedBase });
      const diffFile = path.join(this.store.directory, 'evidence', id, 'change.diff');
      await writeFile(diffFile, action.diff);
      action.diffPath = diffFile;
      this.state.commits.push({ actionId: id, sha: action.commit, branch: tree.branch, status: 'candidate' });
      action.phase = 'REVIEW_REQUIRED';
      await this.event('REVIEW_REQUIRED', { actionId: id, commit: action.commit });
    } catch (error) {
      action.phase = safeError(error).includes('STOP_UNCONFIRMED') ? 'HALTED' : 'FAILED';
      action.error = safeError(error);
      this.state.failures.push({ actionId: id, worker: builder.id, error: action.error, at: new Date().toISOString() });
      updatePerformance(this.state, builder.id, false);
      await this.event(action.phase === 'HALTED' ? 'STOP' : 'REPLAN', { actionId: id, error: action.error });
      if (action.phase === 'HALTED') throw error;
      return action;
    }
    await this.finishReview(action);
    return action;
  }

  async finishReview(action) {
    while (true) {
      try { await this.review(action); return; }
      catch (error) {
        if (action.phase !== 'REVIEW_REQUIRED' || this.pauseRequested) throw error;
        await this.event('REVIEW_REQUIRED', { actionId: action.id, retry: action.reviewAttempts, error: safeError(error) });
      }
    }
  }

  async review(action) {
    if ((action.reviewAttempts ?? 0) >= (this.config.maxReviewAttempts ?? 3)) {
      action.phase = 'HALTED'; await this.checkpoint(); throw new Error('Independent review retry budget exhausted');
    }
    action.reviewAttempts = (action.reviewAttempts ?? 0) + 1;
    if ((await this.worktrees.snapshot(action.worktree.directory)).hash !== action.snapshot.hash) throw new Error('Frozen Builder worktree changed');
    const required = action.risk === 'high' ? ['review', 'security'] : ['review'];
    action.reviews ??= [];
    const reviewers = [];
    for (const capability of required.slice(action.reviews.length)) {
      const identityExclusions = [...this.registry.agents.values()].filter(agent => (agent.identity ?? agent.id) === (action.builderIdentity ?? action.builder) || reviewers.some(other => (other.identity ?? other.id) === (agent.identity ?? agent.id))).map(agent => agent.id);
      reviewers.push(this.registry.select({ role: 'review', capabilities: [capability], risk: action.risk, exclude: [action.builder, ...action.reviews.map(review => review.reviewer), ...identityExclusions, ...reviewers.map(agent => agent.id)] }, this.state.agentPerformance));
    }
    action.phase = 'REVIEWING';
    await this.event('REVIEW', { actionId: action.id });
    let activeReviewer;
    let activeTree, activeSnapshot;
    try {
      for (const reviewer of reviewers) {
        activeReviewer = reviewer.id;
        const tree = await this.worktrees.create(randomUUID(), 'review', action.commit);
        activeTree = tree;
        if (!action.committedTests) action.committedTests = await this.tests(tree.directory, `${action.id}-committed`);
        const initial = await this.worktrees.snapshot(tree.directory);
        activeSnapshot = initial;
        const report = await this.execute(reviewer, { role: 'review', actionId: action.id, workspace: tree.directory, outputSchema: REVIEW_SHAPE,
          prompt: `Independently review this candidate commit ${action.commit}. Source access is read-only. Do not accept Builder claims as evidence.\nGoal: ${action.goal}\nSuccess criteria: ${JSON.stringify(this.state.successCriteria)}\nActual host test results on Builder tree: ${JSON.stringify(action.tests)}\nActual host tests on clean committed tree: ${JSON.stringify(action.committedTests)}\nDiff from accepted baseline:\n${action.diff}\nProtected files intact: ${action.protectedIntact}\nReject failures, regressions, missing evidence or blocking risks. Do not modify files.`,
        });
        if (!['pass', 'reject', 'needs_more_evidence'].includes(report.verdict) || typeof report.reason !== 'string' || !Array.isArray(report.evidence) || !report.evidence.length || !Array.isArray(report.blockingRisks)) throw new Error('Invalid independent review report');
        if ((await this.worktrees.snapshot(tree.directory)).hash !== initial.hash || (await this.worktrees.snapshot(action.worktree.directory)).hash !== action.snapshot.hash) throw new Error('Reviewer modified source or frozen Builder version');
        const boundReport = { ...report, reviewer: reviewer.id, actionId: action.id, commit: action.commit, snapshotHash: action.snapshot.hash, worktree: tree };
        action.reviews.push(boundReport); this.state.reviews.push(boundReport);
        await atomicJson(path.join(this.store.directory, 'evidence', action.id, `review-${reviewer.id}.json`), boundReport);
        await this.checkpoint();
        await this.worktrees.remove(tree);
        activeTree = null;
      }
      const pass = action.protectedIntact === true && action.tests.every(test => test.passed) && action.committedTests.every(test => test.passed) && action.reviews.every(review => review.verdict === 'pass' && review.blockingRisks.length === 0);
      action.phase = pass ? 'MERGE_READY' : 'REJECTED';
      action.finishedAt = new Date().toISOString();
      if (pass) {
        // Accepted state advances by SHA only. Main checkout remains untouched.
        this.state.acceptedHead = action.commit;
        this.state.commits.find(commit => commit.actionId === action.id).status = 'merge-ready';
        updatePerformance(this.state, action.builder, true);
      } else {
        this.state.failures.push({ actionId: action.id, worker: action.builder, reviews: clone(action.reviews), tests: clone(action.tests), protectedIntact: action.protectedIntact, at: new Date().toISOString() });
        updatePerformance(this.state, action.builder, false);
      }
      this.state.evidence.push({ kind: 'action', actionId: action.id, commit: action.commit, tests: clone(action.tests), diffPath: action.diffPath, reviewCount: action.reviews.length, phase: action.phase });
      await this.event('UPDATE', { actionId: action.id, outcome: action.phase });
    } catch (error) {
      if (activeTree && activeSnapshot && (await this.worktrees.snapshot(activeTree.directory)).hash === activeSnapshot.hash) await this.worktrees.remove(activeTree);
      if (activeReviewer) updatePerformance(this.state, activeReviewer, false);
      action.phase = action.reviewAttempts >= (this.config.maxReviewAttempts ?? 3) || safeError(error).includes('modified') || safeError(error).includes('STOP_UNCONFIRMED') ? 'HALTED' : 'REVIEW_REQUIRED';
      action.error = safeError(error);
      await this.checkpoint();
      throw error;
    }
  }

  async start({ maxActions = this.config.maxActions ?? 10 } = {}) {
    if (this.running) throw new Error('Loop is already running');
    if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new Error('maxActions must be 1..100');
    this.running = true;
    this.idle = new Promise(resolve => { this.resolveIdle = resolve; });
    this.pauseRequested = false;
    let release;
    try {
      release = await this.store.acquire();
      await this.initialize();
      const last = this.state.actions.at(-1);
      if (last && ['BUILDING', 'HALTED'].includes(last.phase)) throw new Error('Recovery required: interrupted or unconfirmed Worker');
      this.state.status = 'running';
      delete this.state.lastError;
      if (last && ['REVIEW_REQUIRED', 'REVIEWING'].includes(last.phase)) await this.finishReview(last);
      for (let round = 0; round < maxActions && !this.pauseRequested; round++) {
        const { observation, tree } = await this.observation();
        let selected;
        try { selected = await this.decide(observation, tree); }
        finally { await this.worktrees.remove(tree); }
        if (!selected) break;
        if (this.pauseRequested) break;
        await this.build(selected);
        await this.event('REPLAN'); // No queued TODO survives this boundary.
      }
      if (this.state.status !== 'complete') { this.state.status = this.pauseRequested ? 'paused' : 'budget-exhausted'; await this.event('STOP', { reason: this.state.status }); }
    } catch (error) {
      if (this.state) { this.state.status = 'stopped'; this.state.lastError = safeError(error); await this.event('STOP', { error: safeError(error) }); }
      throw error;
    } finally {
      this.running = false;
      if (release) await release();
      this.emit('state', this.view());
      this.resolveIdle();
    }
    return clone(this.state);
  }
  pause() { this.pauseRequested = true; return { status: 'pause-requested', boundary: 'after-current-governed-action' }; }
  async cancel() { this.pauseRequested = true; this.controller?.abort(); if (this.currentRun) await this.currentRun.run.dispose(); }
  async close() { await this.cancel(); if (this.running) await this.idle; }
  async artifact(relative) {
    const target = path.resolve(this.store.directory, relative);
    const relation = path.relative(this.store.directory, target);
    if (!relation.startsWith(`evidence${path.sep}`) || relation.split(path.sep).includes('..')) throw new Error('Only evidence artifacts may be read');
    const real = await realpath(target);
    const realRelation = path.relative(await realpath(path.join(this.store.directory, 'evidence')), real);
    if (path.isAbsolute(realRelation) || realRelation === '..' || realRelation.startsWith(`..${path.sep}`)) throw new Error('Artifact symlink escapes evidence directory');
    if ((await stat(real)).size > 8 * 1024 * 1024) throw new Error('Artifact exceeds 8 MiB limit');
    return redact(await readFile(target, 'utf8'));
  }
}
