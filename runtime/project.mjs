import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorldStore, clone, atomicJson } from './store.mjs';
import { WorktreeManager, hash } from './worktrees.mjs';
import { AgentRegistry, updatePerformance } from './registry.mjs';
import { ModelDecision, REVIEW_SHAPE, validateAssessment } from './decision.mjs';
import { policyFor } from './permissions.mjs';
import { runCommand, redact } from './process.mjs';
import { changedPathRisk, sourceObservation, testSummary } from './governance.mjs';
import { CommercialLoop } from './commercial.mjs';
import { normalizeModelRegistry, routeModel, RoutingError } from './routing.mjs';

const safeError = error => redact(error instanceof Error ? error.message : String(error));

/** Project-level Loop hosted by DSH's control plugin, separate from its Agent loop. */
export class ProjectRuntime extends EventEmitter {
  constructor(config, { agents = [], assessment, observe, afterBuild, research } = {}) {
    super();
    if (!config.goal?.trim() || !Array.isArray(config.successCriteria) || !config.successCriteria.length || !config.repository || !config.stateDir || !Array.isArray(config.tests) || !config.tests.length) throw new Error('Goal, repository, stateDir, successCriteria and host-owned tests required');
    this.config = clone(config);
    this.repository = path.resolve(config.repository);
    this.store = new WorldStore(config.stateDir);
    this.id = hash(this.repository).slice(0, 12);
    this.worktrees = new WorktreeManager(this.repository, path.join(this.store.directory, 'worktrees'), this.id);
    this.registry = new AgentRegistry();
    agents.forEach(agent => this.registry.add(agent));
    this.assertModelRegistry();
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
    if (config.commercialLoop?.enabled) {
      this.commercial = new CommercialLoop(this, research);
      this.modelDecision.preferred = () => this.sharedWorker('decide', ['reason']).id;
      this.modelDecision.execute = this.executeWithHandoff.bind(this);
    }
  }

  async initialize() {
    await this.store.assertOutside(this.repository);
    await this.worktrees.validate();
    const loaded = await this.store.load();
    const policyHash = hash({ tests: this.config.tests, protectedPaths: this.config.protectedPaths ?? [], constraints: this.config.constraints ?? [], commercialLoop: this.config.commercialLoop });
    if (loaded) {
      if (loaded.project.repository !== this.repository || loaded.goal !== this.config.goal || hash(loaded.successCriteria) !== hash(this.config.successCriteria) || hash(loaded.permissions) !== hash(this.config.permissions ?? {})) throw new Error('Project configuration differs from persisted state; create a new stateDir');
      this.state = loaded;
      if (loaded.policyHash && loaded.policyHash !== policyHash) throw new Error('Host tests or constraints differ from persisted policy; create a new stateDir');
      if (!loaded.policyHash) { loaded.policyHash = policyHash; await this.checkpoint(); }
      const previousAlignment = loaded.alignments?.at(-1);
      if (this.commercial && previousAlignment?.notesPath) this.lastAlignment = { ...previousAlignment, text: await this.artifact(previousAlignment.notesPath) };
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

  /** Host model registry as a non-empty array, or null when none is configured. */
  modelCatalog() {
    const registry = this.config.models;
    const models = Array.isArray(registry) ? registry : registry?.models;
    return Array.isArray(models) && models.length ? models : null;
  }

  /** Validate the Host model registry once; enforce the static-model rule when routing is disabled. */
  assertModelRegistry() {
    const catalog = this.modelCatalog();
    if (!catalog) return;
    normalizeModelRegistry(catalog);
    if (this.config.autoModelRouting === false) {
      for (const agent of this.registry.agents.values()) {
        if (!agent.model) continue;
        const entry = catalog.find(model => model?.id === agent.model);
        if (!entry || entry.prohibited === true || entry.eligible === false) throw new RoutingError(`Static model ${agent.model} is not an eligible entry in the Host model registry`, 'INELIGIBLE_STATIC_MODEL');
      }
    }
  }

  /** Host-computed providers currently quarantined, including shared quotaGroup members. */
  unavailableProviders() {
    const unavailable = this.registry.unavailable();
    const providers = new Set();
    for (const agent of this.registry.agents.values()) if (unavailable.has(agent.id) && agent.provider) providers.add(agent.provider);
    return [...providers];
  }

  /**
   * Select a model for the already-chosen Worker. Returns inspectable routing
   * evidence, or undefined when no Host catalog is configured (static fallback).
   * Throws RoutingError (fail closed); it never mutates Worker availability.
   */
  routeFor(agent, task) {
    const catalog = this.modelCatalog();
    if (!catalog || this.config.autoModelRouting === false) return undefined;
    const selection = routeModel({
      provider: agent.provider,
      role: task.role,
      capabilities: task.capabilities,
      security: task.security,
      risk: task.risk,
      escalate: task.escalate,
      unavailable: this.unavailableProviders(),
    }, catalog);
    return { selectedModel: selection.selectedModel, provider: selection.provider, reason: selection.reason, inputs: selection.inputs, at: new Date().toISOString() };
  }

  sharedWorker(role, capabilities = [], exclude = []) {
    const id = this.state.sharedWorker ?? this.config.commercialLoop?.worker;
    const current = this.registry.agents.get(id);
    const unavailable = this.registry.unavailable();
    if (current && !unavailable.has(current.id) && current.roles.includes(role) && capabilities.every(c => current.capabilities.includes(c)) && !exclude.includes(current.id)) return current;
    const next = this.registry.select({ role, capabilities, exclude }, this.state.agentPerformance);
    this.state.sharedWorker = next.id;
    return next;
  }

  async executeWithHandoff(initial, task) {
    let agent = initial;
    const attempted = [];
    while (true) {
      attempted.push(agent.id);
      try {
        const result = await this.execute(agent, task);
        this.state.sharedWorker = agent.id;
        return { ...result, worker: agent.id };
      } catch (error) {
        if (agent.availability !== 'offline' || safeError(error).includes('STOP_UNCONFIRMED')) throw error;
        const snapshot = await this.worktrees.snapshot(task.workspace);
        const handoff = { id: randomUUID(), from: agent.id, role: task.role, actionId: task.actionId, workspace: task.workspace, snapshotHash: snapshot.hash, error: safeError(error), at: new Date().toISOString(), status: 'waiting' };
        this.state.handoffs ??= []; this.state.handoffs.push(handoff);
        await atomicJson(path.join(this.store.directory, 'evidence', handoff.id, 'checkpoint.json'), { ...handoff, snapshot, goal: this.state.goal, prompt: task.prompt, latestAlignment: this.lastAlignment?.text });
        await this.checkpoint();
        const next = this.sharedWorker(task.role, task.role === 'build' ? task.capabilities ?? [] : ['reason'], attempted);
        if ((await this.worktrees.snapshot(task.workspace)).hash !== snapshot.hash) throw new Error('Handoff workspace changed before takeover');
        if (task.role === 'build') {
          const action = this.state.actions.find(action => action.id === task.actionId);
          action.builderIdentities ??= [action.builderIdentity];
          action.builderIdentities.push(next.identity ?? next.id);
          action.builderHistory ??= [action.builder]; action.builderHistory.push(next.id);
          action.builder = next.id; action.builderIdentity = next.identity ?? next.id;
        }
        handoff.to = next.id; handoff.status = 'resuming';
        this.state.sharedWorker = next.id;
        await this.checkpoint();
        task = { ...task, prompt: `${task.prompt}\nHandoff: ${agent.id} exhausted quota/unavailable after confirmed stop. Continue this SAME action in the preserved workspace; inspect existing partial changes, do not restart blindly. Previous error: ${handoff.error}. Snapshot: ${snapshot.hash}. Do not commit or schedule another task.` };
        agent = next;
      }
    }
  }

  async alignment(stage, observation, tree, action, enforce = true) {
    if (!this.commercial) return;
    let record;
    const limit = this.config.commercialLoop.maxAlignmentAttempts ?? 2;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw new Error('maxAlignmentAttempts must be 1..3');
    for (let attempt = 0; attempt < limit; attempt++) {
      // A NEED_RESEARCH/WRONG_DIRECTION retry must change the available evidence
      // rather than only repeat analysis against the same failed cache: the retry
      // context tells the stage which references already failed and asks for new
      // candidate URLs so the bounded recovery path can actually change sources.
      const retry = attempt === 0 || !record ? null : {
        attempt,
        priorOutcome: record.audit.outcome,
        priorSources: record.sources.map(source => source.url).filter(Boolean),
      };
      record = await this.commercial.stage(stage, observation, tree, action, retry);
      if (!enforce || !['NEED_RESEARCH', 'WRONG_DIRECTION'].includes(record.audit.outcome)) break;
    }
    if (enforce && record.audit.outcome !== 'PASS') throw new Error(`COMMERCIAL_${record.audit.outcome}: ${record.audit.reason}`);
    return record;
  }

  async execute(agent, task) {
    const runKey = randomUUID();
    const artifactDir = path.join(this.store.directory, 'evidence', task.actionId ?? runKey);
    await mkdir(artifactDir, { recursive: true });
    // Recompute routing for whichever Worker is about to run, including any
    // handoff successor. A fail-closed RoutingError propagates as an ordinary
    // FAILED action and never marks the provider offline.
    const routing = this.routeFor(agent, task);
    if (routing) task.onRouting?.(routing);
    const abort = new AbortController();
    this.controller = abort;
    const started = Date.now();
    const launchIntent = { id: runKey, launchToken: runKey, worker: agent.id, role: task.role, actionId: task.actionId, workspace: task.workspace, status: 'preparing', startedAt: new Date().toISOString(), ...(routing ? { routing } : {}) };
    this.state.runs.push(launchIntent);
    await this.checkpoint(); // Durable before any Worker is spawned.
    let run;
    try {
      run = await agent.start({ ...task, model: routing?.selectedModel, runKey, artifactDir, permissions: policyFor(task.role, this.state.permissions), timeoutMs: this.config.agentTimeoutMs ?? 300_000, signal: abort.signal, onEvent: event => {
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
    const { sources, sourceCoverage } = await sourceObservation(tree.directory, snapshot.evidence.files, this.config.sourceBudgetBytes ?? 120_000);
    const extra = this.observeExtra ? await this.observeExtra(clone(this.state), tree.directory) : {};
    const observation = { ...clone(extra), at: new Date().toISOString(), head: observedHead, acceptedHead: this.state.acceptedHead, tests: testSummary(tests), snapshot, sources, sourceCoverage };
    const artifactPath = path.join('evidence', `observe-${this.state.revision}`, 'observation.json');
    await atomicJson(path.join(this.store.directory, artifactPath), observation);
    this.lastObservation = observation;
    this.state.evidence.push({ kind: 'observation', at: observation.at, head: observedHead, acceptedHead: this.state.acceptedHead, artifactPath, snapshotHash: snapshot.hash, tests: observation.tests.map(({ output, ...report }) => report), sourceCoverage });
    return { observation, tree };
  }

  async decide(observation, tree) {
    await this.event('DECIDE');
    // Imperfect diagnosis is input, not permission to execute. Plan and
    // candidate/completion gates still require independent PASS.
    await this.alignment('observe-and-prioritize', observation, tree, undefined, false);
    if (this.lastAlignment) {
      observation.alignmentAnalysis = this.lastAlignment.text;
      observation.alignmentAudit = this.lastAlignment.audit;
    }
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
      await this.alignment('commercial-completion', observation, tree);
      this.state.status = 'complete'; await this.event('STOP', { reason: assessment.reason }); return null;
    }
    const priorities = new Map(assessment.gaps.map(gap => [gap.id, gap.priority]));
    const candidates = assessment.candidates.toSorted((a, b) => priorities.get(b.gapId) - priorities.get(a.gapId));
    if (!candidates.length) throw new Error('Project incomplete but no executable candidate');
    const candidate = candidates[0];
    const previous = this.state.actions.at(-1);
    const exclude = !this.commercial && previous?.phase === 'FAILED' && this.state.agentPerformance[previous.builder]?.consecutiveFailures >= 3 ? [previous.builder] : [];
    const builder = this.commercial ? this.sharedWorker('build', candidate.capabilities, exclude) : this.registry.select({ role: 'build', capabilities: candidate.capabilities, risk: candidate.risk, exclude }, this.state.agentPerformance);
    const selected = { ...candidate, workerId: builder.id, scoreInputs: clone(this.state.agentPerformance), reason: candidate.rationale ?? assessment.reason };
    decision.selected = selected;
    await this.checkpoint();
    await this.alignment('plan', { ...observation, proposedAction: selected }, tree);
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
    const beforeBuild = await this.worktrees.snapshot(tree.directory);
    await this.event('BUILD', { actionId: id });
    try {
      await this.alignment('execution-route', this.lastObservation, tree, action);
      const activeBuilder = this.commercial ? this.sharedWorker('build', candidate.capabilities) : builder;
      action.builder = activeBuilder.id; action.builderIdentity = activeBuilder.identity ?? activeBuilder.id;
      const execute = this.commercial ? this.executeWithHandoff.bind(this) : this.execute.bind(this);
      // The builder's pre-dispatch risk is Host-computed from the validated
      // candidate, never the Worker's self-report. Routing only picks a model
      // for the already-selected Worker.
      let builderRouting;
      action.builderResult = await execute(activeBuilder, { role: 'build', actionId: id, capabilities: candidate.capabilities, risk: action.risk, onRouting: selection => { builderRouting = selection; }, workspace: tree.directory, outputFormat: this.commercial ? 'text' : undefined, prompt: `Goal: ${action.goal}\nProject goal: ${this.state.goal}\nCriteria: ${JSON.stringify(this.state.successCriteria)}\nDiagnosis: ${JSON.stringify(this.state.gaps)}\nAlignment feedback: ${this.lastAlignment?.text ?? ''}\nCurrent source evidence: ${JSON.stringify(this.lastObservation?.sources ?? {})}\nHost observation and live contracts: ${JSON.stringify({ ...this.lastObservation, sources: undefined, snapshot: { hash: this.lastObservation?.snapshot?.hash } })}\nPrevious review findings: ${JSON.stringify(previous?.reviews ?? [])}\nProtected files must not be changed: ${JSON.stringify(this.config.protectedPaths ?? [])}. Modify source only. Check alignment during execution. If the route is wrong, report it rather than silently expanding scope. Host runs tests and commits after you stop.`, outputSchema: { summary: 'string', filesChanged: ['string'] } });
      if (builderRouting) action.routing = builderRouting;
      if (this.afterBuild) {
        const evidence = await this.afterBuild(clone(action), tree.directory);
        if (evidence) this.state.evidence.push({ kind: 'environment-event', actionId: id, ...clone(evidence) });
      }
      if ((await this.worktrees.snapshot(tree.directory)).hash === beforeBuild.hash) {
        action.phase = 'NO_CHANGE'; action.finishedAt = new Date().toISOString();
        this.state.failures.push({ actionId: id, worker: builder.id, error: 'No source change; no commit or accepted progress', at: action.finishedAt });
        updatePerformance(this.state, action.builder, false);
        await this.event('UPDATE', { actionId: id, outcome: 'NO_CHANGE' });
        return action;
      }
      action.protectedIntact = hash(protectedBefore) === hash(await this.worktrees.protectedHashes(tree.directory, this.config.protectedPaths ?? []));
      action.tests = await this.tests(tree.directory, id);
      action.commit = await this.worktrees.commit(tree, `DSH action ${id}: ${action.goal}`);
      action.snapshot = await this.worktrees.snapshot(tree.directory);
      action.diff = await this.worktrees.diff({ ...tree, base: action.acceptedBase });
      action.actionDiff = await this.worktrees.diff(tree);
      const changedPaths = (await this.worktrees.git(tree.directory, ['diff', '--name-only', '-z', `${action.acceptedBase}..${action.commit}`])).split('\0').filter(Boolean);
      action.riskEvidence = changedPathRisk(changedPaths, action.diff);
      if (action.riskEvidence.risk === 'high') action.risk = 'high';
      this.state.riskLevel = action.risk;
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
      updatePerformance(this.state, action.builder, false);
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
    // Allocate the constrained security capability first so a general review
    // cannot consume the only available security reviewer.
    const required = action.risk === 'high' ? ['security', 'review'] : ['review'];
    action.reviews ??= [];
    const reviewers = [];
    for (const capability of required.slice(action.reviews.length)) {
      const usedIdentities = [...(action.builderIdentities ?? [action.builderIdentity ?? action.builder]), ...action.reviews.map(review => this.registry.agents.get(review.reviewer)?.identity ?? review.reviewer), ...reviewers.map(other => other.identity ?? other.id)];
      const identityExclusions = [...this.registry.agents.values()].filter(agent => usedIdentities.includes(agent.identity ?? agent.id)).map(agent => agent.id);
      reviewers.push(this.registry.select({ role: 'review', capabilities: [capability], risk: action.risk, exclude: [action.builder, ...(action.builderHistory ?? []), ...action.reviews.map(review => review.reviewer), ...identityExclusions, ...reviewers.map(agent => agent.id)] }, this.state.agentPerformance));
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
        if (this.commercial && !action.commercialReview) action.commercialReview = await this.alignment('verify', { ...this.lastObservation, tests: testSummary(action.committedTests) }, tree, action, false);
        const initial = await this.worktrees.snapshot(tree.directory);
        activeSnapshot = initial;
        const actionDiff = action.actionDiff ?? await this.worktrees.diff(action.worktree);
        const report = await this.execute(reviewer, { role: 'review', actionId: action.id, security: required[action.reviews.length] === 'security', risk: action.risk, workspace: tree.directory, outputSchema: REVIEW_SHAPE,
          prompt: `Independently perform ${required[action.reviews.length]} review of this candidate commit ${action.commit}. Source access is read-only. Do not accept Builder claims as evidence.\nGoal: ${action.goal}\nSuccess criteria: ${JSON.stringify(this.state.successCriteria)}\nActual host test results on Builder tree: ${JSON.stringify(action.tests)}\nActual host tests on clean committed tree: ${JSON.stringify(action.committedTests)}\nCurrent action delta from its dispatch base:\n${actionDiff}\nCumulative candidate diff from accepted baseline (includes inherited rejected work):\n${action.diff}\nApply action-specific file scope to the current action delta, not inherited changes. Evaluate the ENTIRE cumulative candidate against project criteria and protected policy.\nProtected files intact: ${action.protectedIntact}\nReject failures, regressions, missing evidence or blocking risks. Do not modify files.`,
        });
        if (!['pass', 'reject', 'needs_more_evidence'].includes(report.verdict) || typeof report.reason !== 'string' || !Array.isArray(report.evidence) || !report.evidence.length || !Array.isArray(report.blockingRisks)) throw new Error('Invalid independent review report');
        if ((await this.worktrees.snapshot(tree.directory)).hash !== initial.hash || (await this.worktrees.snapshot(action.worktree.directory)).hash !== action.snapshot.hash) throw new Error('Reviewer modified source or frozen Builder version');
        const boundReport = { ...report, reviewer: reviewer.id, capability: required[action.reviews.length], actionId: action.id, commit: action.commit, snapshotHash: action.snapshot.hash, worktree: tree };
        action.reviews.push(boundReport); this.state.reviews.push(boundReport);
        await atomicJson(path.join(this.store.directory, 'evidence', action.id, `review-${reviewer.id}.json`), boundReport);
        await this.checkpoint();
        await this.worktrees.remove(tree);
        activeTree = null;
      }
      const pass = (!this.commercial || action.commercialReview?.audit.outcome === 'PASS') && action.protectedIntact === true && action.tests.every(test => test.passed) && action.committedTests.every(test => test.passed) && action.reviews.length === required.length && action.reviews.every(review => review.verdict === 'pass' && review.blockingRisks.length === 0);
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
      if (this.state) { this.state.status = safeError(error).startsWith('COMMERCIAL_') ? 'blocked' : 'stopped'; this.state.lastError = safeError(error); await this.event('STOP', { error: safeError(error) }); }
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
