import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorldStore, clone, atomicJson } from './store.mjs';
import { WorktreeManager, hash } from './worktrees.mjs';
import { AgentRegistry, updatePerformance } from './registry.mjs';
import { ModelDecision, REVIEW_SHAPE, validateAssessment } from './decision.mjs';
import { policyFor } from './permissions.mjs';
import { runCommand, redact, classifyFailure } from './process.mjs';
import { changedPathRisk, sourceObservation, testSummary } from './governance.mjs';
import { CommercialLoop } from './commercial.mjs';
import { normalizeModelRegistry, routeModel, RoutingError } from './routing.mjs';
import { reservePaidApiRun, eligiblePaidConnections } from './paid-authorization.mjs';

const safeError = error => redact(error instanceof Error ? error.message : String(error));
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item) : [];
const identitiesOf = agent => [...new Set([agent?.id, agent?.identity, ...strings(agent?.identityAliases)])].filter(Boolean);
const identityLabelsOf = agent => [...new Set([agent?.identity ?? agent?.id, ...strings(agent?.identityAliases)])].filter(Boolean);

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
    this.paidModelEligibility = new Set();
    this.registry.eligible = agent => !agent.paidApi || [...this.paidModelEligibility].some(key => key.startsWith(`${agent.connectionId ?? agent.id}\0`));
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
      await this.refreshPaidEligibility();
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
    await this.refreshPaidEligibility();
    return clone(this.state);
  }

  async refreshPaidEligibility() {
    const models = this.modelCatalog() ? normalizeModelRegistry(this.modelCatalog()) : [];
    const requirements = [];
    for (const agent of this.registry.agents.values()) {
      if (!agent.paidApi?.endpoint) continue;
      const connectionId = agent.connectionId ?? agent.id;
      const paidEndpoint = agent.paidApi.endpoint.replace(/\/$/, '');
      const candidates = !models.length
        ? [agent.model].filter(Boolean).map(modelId => ({ id: modelId, paid: true, eligible: true, endpoint: paidEndpoint, connectionId }))
        : models.filter(model => model.paid && model.eligible !== false && model.connectionId === connectionId && model.endpoint.replace(/\/$/, '') === paidEndpoint);
      for (const model of candidates) requirements.push({ connectionId, modelId: model.id, endpoint: model.endpoint });
    }
    this.paidModelEligibility = new Set(await eligiblePaidConnections({ stateDir: this.store.directory, project: this.repository, requirements }));
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
    const connectionIds = new Set();
    for (const agent of this.registry.agents.values()) {
      if (!agent.connectionId) continue;
      if (connectionIds.has(agent.connectionId)) throw new RoutingError(`Duplicate connectionId ${agent.connectionId}; each adapter alias needs a distinct connection identity`, 'INVALID_CONNECTION');
      connectionIds.add(agent.connectionId);
    }
    const catalog = this.modelCatalog();
    if (!catalog) return;
    const models = normalizeModelRegistry(catalog);
    const transports = new Map();
    for (const agent of this.registry.agents.values()) {
      if (!agent.provider) continue;
      if (!transports.has(agent.provider)) transports.set(agent.provider, new Set());
      if (agent.connectionId) transports.get(agent.provider).add(agent.connectionId);
    }
    for (const model of models) {
      if (model.connectionId === undefined && (transports.get(model.provider)?.size ?? 0) > 1) throw new RoutingError(`Model ${model.id} must identify a connection because ${model.provider} has multiple configured connections`, 'AMBIGUOUS_CONNECTION');
    }
    for (const agent of this.registry.agents.values()) {
      if (!agent.paidApi) continue;
      const paidEndpoint = agent.paidApi.endpoint?.replace(/\/$/, '');
      if (!paidEndpoint || agent.openCodeProvider?.baseURL.replace(/\/$/, '') !== paidEndpoint) throw new RoutingError(`Paid connection ${agent.connectionId ?? agent.id} requires a matching custom-provider endpoint`, 'INVALID_REGISTRY');
      if (agent.model) {
        const staticModel = models.find(model => model.id === agent.model && model.connectionId === (agent.connectionId ?? agent.id ?? agent.provider));
        if (!staticModel?.paid || staticModel.endpoint.replace(/\/$/, '') !== paidEndpoint) throw new RoutingError(`Paid connection ${agent.connectionId ?? agent.id} static model ${agent.model} must be explicitly marked paid at its exact endpoint`, 'INVALID_REGISTRY');
      }
    }
    for (const model of models) {
      if (model.paid && (!model.connectionId || !model.endpoint)) throw new RoutingError(`Paid model ${model.id} requires exact connectionId and endpoint metadata`, 'INVALID_REGISTRY');
      if (model.connectionId && ![...this.registry.agents.values()].some(agent => (agent.connectionId ?? agent.id ?? agent.provider) === model.connectionId)) throw new RoutingError(`Model ${model.id} references unknown connection ${model.connectionId}`, 'INVALID_REGISTRY');
      if (model.paid && ![...this.registry.agents.values()].some(agent => {
        const agentEndpoint = agent.paidApi?.endpoint?.replace(/\/$/, '');
        return (agent.connectionId ?? agent.id ?? agent.provider) === model.connectionId && agentEndpoint === model.endpoint.replace(/\/$/, '') && agent.openCodeProvider?.baseURL.replace(/\/$/, '') === model.endpoint.replace(/\/$/, '');
      })) throw new RoutingError(`Paid model ${model.id} lacks matching paid connection metadata`, 'INVALID_REGISTRY');
    }
    const collisions = new Map();
    for (const model of models) collisions.set(model.id, (collisions.get(model.id) ?? 0) + 1);
    for (const [id, count] of collisions) if (count > 1 && models.filter(model => model.id === id).some(model => !model.connectionId)) throw new RoutingError(`Repeated model id ${id} requires explicit connection identity on every entry`, 'INVALID_REGISTRY');
    if (this.config.autoModelRouting === false) {
      for (const agent of this.registry.agents.values()) {
        if (!agent.model) continue;
        const entry = catalog.find(model => model?.id === agent.model && (!model.connectionId || model.connectionId === (agent.connectionId ?? agent.id ?? agent.provider)));
        if (!entry || entry.prohibited === true || (entry.eligible === false && !agent.paidApi)) throw new RoutingError(`Static model ${agent.model} is not an eligible entry in the Host model registry`, 'INELIGIBLE_STATIC_MODEL');
      }
    }
  }

  /** Host-computed connections currently quarantined, including shared quotaGroup members. */
  unavailableConnections() {
    const unavailable = this.registry.unavailable();
    const connections = new Set();
    for (const agent of this.registry.agents.values()) if (unavailable.has(agent.id)) connections.add(agent.connectionId ?? agent.provider ?? agent.id);
    return [...connections];
  }

  /**
   * Select a model for the already-chosen Worker. Returns inspectable routing
   * evidence, or undefined when no Host catalog is configured (static fallback).
   * Throws RoutingError (fail closed); it never mutates Worker availability.
   */
  routeFor(agent, task) {
    const catalog = this.modelCatalog();
    if (!catalog || this.config.autoModelRouting === false) {
      const selectedModel = task.model ?? agent.model;
      const modelEntry = catalog && selectedModel && normalizeModelRegistry(catalog).find(model => model.id === selectedModel
        && model.provider === agent.provider && (!model.connectionId || model.connectionId === (agent.connectionId ?? agent.id ?? agent.provider)));
      if (catalog && selectedModel && (!modelEntry || !modelEntry.eligible || modelEntry.prohibited)) throw new RoutingError(`Static model ${selectedModel} is not eligible for connection ${agent.connectionId ?? agent.id}`, 'INELIGIBLE_STATIC_MODEL');
      const securityRequired = task.security === true || task.capabilities?.includes('security') || task.requiredCapabilities?.includes('security');
      const requiredTier = securityRequired ? 'security' : (task.risk === 'high' || task.escalate === true) ? 'deep' : 'routine';
      const acceptableTiers = requiredTier === 'security' ? ['security'] : requiredTier === 'deep' ? ['deep', 'security'] : ['routine'];
      if (modelEntry && !acceptableTiers.includes(modelEntry.tier)) throw new RoutingError(`Static model ${selectedModel} does not satisfy required ${requiredTier} tier for ${task.role}`, 'NO_ELIGIBLE_MODEL');
      if (agent.paidApi) {
        const endpoint = agent.paidApi.endpoint?.replace(/\/$/, '');
        const key = `${agent.connectionId ?? agent.id}\0${selectedModel}\0${endpoint}`;
        if (!selectedModel || !endpoint || (catalog && (!modelEntry?.paid || modelEntry.endpoint.replace(/\/$/, '') !== endpoint)) || !this.paidModelEligibility.has(key)) {
          const error = new Error(`Paid API authorization needed for connection ${agent.connectionId ?? agent.id}, model ${selectedModel}`);
          error.failureKind = 'authorization-needed';
          throw error;
        }
      }
      if (modelEntry?.paid && !agent.paidApi) {
        const error = new Error(`Paid API authorization needed: model ${selectedModel} requires its explicitly configured paid connection`);
        error.failureKind = 'authorization-needed';
        throw error;
      }
      return undefined;
    }
    const connectionId = agent.connectionId;
    const eligibleCatalog = normalizeModelRegistry(catalog).filter(model => !model.paid || this.paidModelEligibility.has(`${model.connectionId}\0${model.id}\0${model.endpoint.replace(/\/$/, '')}`));
    let selection;
    try { selection = routeModel({
      provider: agent.provider,
      ...(connectionId ? { connectionId } : {}),
      role: task.role,
      capabilities: task.capabilities,
      security: task.security,
      risk: task.risk,
      escalate: task.escalate,
      unavailable: [...this.unavailableConnections(), ...(task.unavailableModels ?? [])],
    }, eligibleCatalog); }
    catch (error) {
      const paidChoiceDenied = normalizeModelRegistry(catalog).some(model => model.paid && model.eligible && model.connectionId === connectionId && !this.paidModelEligibility.has(`${model.connectionId}\0${model.id}\0${model.endpoint.replace(/\/$/, '')}`));
      if (paidChoiceDenied && ['NO_ELIGIBLE_MODEL', 'EMPTY_REGISTRY'].includes(error.code)) {
        const blocked = new Error(`Paid API authorization needed for connection ${connectionId}; no eligible funded model remains`);
        blocked.failureKind = 'authorization-needed';
        throw blocked;
      }
      throw error;
    }
    if (selection.paid && (!agent.paidApi
      || (agent.connectionId ?? agent.id) !== selection.connectionId
      || agent.paidApi.endpoint?.replace(/\/$/, '') !== selection.endpoint?.replace(/\/$/, ''))) {
      const error = new Error(`Paid API authorization needed for connection ${selection.connectionId}, model ${selection.selectedModel}`);
      error.failureKind = 'authorization-needed';
      throw error;
    }
    return { selectedModel: selection.selectedModel, provider: selection.provider, connectionId: selection.connectionId, paid: selection.paid, endpoint: selection.endpoint, reason: selection.reason, inputs: selection.inputs, at: new Date().toISOString() };
  }

  /** Resolve the selected adapter and its model together before any Worker preparation. */
  resolveAgentForTask(initial, task) {
    const excluded = [...new Set([...(task.excludeAgents ?? []), ...(task.reservedReviewerIds ?? [])])];
    const excludedIdentities = new Set([...(task.excludeIdentities ?? []), ...(task.reservedReviewerIdentities ?? [])]);
    const requiredCapabilities = [...new Set([...(task.capabilities ?? []), ...(task.requiredCapabilities ?? [])])];
    const failures = [];
    let deniedPaidConnection;
    let candidate = initial;
    const allowed = agent => agent && agent.roles?.includes(task.role) && requiredCapabilities.every(capability => agent.capabilities?.includes(capability))
      && !excluded.includes(agent.id) && !identitiesOf(agent).some(identity => excludedIdentities.has(identity));
    if (!allowed(candidate)) {
      try { candidate = this.registry.select({ role: task.role, capabilities: requiredCapabilities, risk: task.risk, exclude: excluded, excludeIdentities: [...excludedIdentities] }, this.state.agentPerformance); }
      catch { candidate = undefined; }
    }
    while (allowed(candidate)) {
      excluded.push(candidate.id);
      for (const identity of identitiesOf(candidate)) excludedIdentities.add(identity);
      try {
        const routing = this.routeFor(candidate, task);
        task.validateSelected?.(candidate, routing);
        return { agent: candidate, routing };
      } catch (error) {
        if (error.failureKind !== 'authorization-needed' && !['NO_ELIGIBLE_MODEL', 'EMPTY_REGISTRY', 'INELIGIBLE_STATIC_MODEL'].includes(error.code)) throw error;
        if (candidate.paidApi) deniedPaidConnection ??= candidate.connectionId ?? candidate.id;
        failures.push(error);
      }
      try {
        candidate = this.registry.select({ role: task.role, capabilities: requiredCapabilities, risk: task.risk, exclude: excluded, excludeIdentities: [...excludedIdentities] }, this.state.agentPerformance);
      } catch {
        candidate = undefined;
      }
    }
    const authFailure = failures.find(error => error.failureKind === 'authorization-needed');
    if (authFailure) throw authFailure;
    if (deniedPaidConnection) {
      const error = new Error(`Paid API authorization needed for connection ${deniedPaidConnection}; no permitted alternative can satisfy ${task.role}/${requiredCapabilities.join(',')}`);
      error.failureKind = 'authorization-needed';
      throw error;
    }
    if (failures.length) throw failures.at(-1);
    throw Object.assign(new Error(`No eligible Worker for ${task.role}; paid API authorization may be required`), { failureKind: 'authorization-needed' });
  }

  sharedWorker(role, capabilities = [], exclude = [], excludeIdentities = []) {
    const id = this.state.sharedWorker ?? this.config.commercialLoop?.worker;
    const current = this.registry.agents.get(id);
    const unavailable = this.registry.unavailable();
    if (current && this.registry.eligible(current) && !unavailable.has(current.id) && current.roles.includes(role) && capabilities.every(c => current.capabilities.includes(c)) && !exclude.includes(current.id) && !identitiesOf(current).some(identity => excludeIdentities.includes(identity))) return current;
    const next = this.registry.select({ role, capabilities, exclude, excludeIdentities }, this.state.agentPerformance);
    this.state.sharedWorker = next.id;
    return next;
  }

  async executeWithHandoff(initial, task) {
    let agent = initial;
    const attempted = [];
    const attemptedIdentities = new Set();
    let handoff;
    while (true) {
      if (!attempted.includes(agent.id)) attempted.push(agent.id);
      for (const identity of identitiesOf(agent)) attemptedIdentities.add(identity);
      const currentIdentities = new Set(identitiesOf(agent));
      const priorAttempted = attempted.filter(id => id !== agent.id);
      const priorIdentities = [...attemptedIdentities].filter(identity => !currentIdentities.has(identity));
      const outerOnRouting = task.onRouting;
      let attemptRouting;
      const attemptTask = { ...task, excludeAgents: [...new Set([...(task.excludeAgents ?? []), ...priorAttempted])],
        excludeIdentities: [...new Set([...(task.excludeIdentities ?? []), ...priorIdentities])], onRouting: routing => {
        attemptRouting = routing;
        outerOnRouting?.(routing);
        if (handoff) {
          handoff.routing = routing;
          handoff.selectedModel = routing.selectedModel;
          handoff.routingReason = routing.reason;
        }
      }, onWorkerSelected: async selected => {
        if (!attempted.includes(selected.id)) attempted.push(selected.id);
        for (const identity of identitiesOf(selected)) attemptedIdentities.add(identity);
        agent = selected;
        await task.onWorkerSelected?.(selected);
      } };
      try {
      const result = await this.execute(agent, attemptTask);
        if (handoff) { handoff.status = 'resuming'; handoff.selectedModel ??= attemptRouting?.selectedModel; handoff.routingReason ??= attemptRouting?.reason; await this.checkpoint(); }
        this.state.sharedWorker = agent.id;
        return { ...result, worker: agent.id };
      } catch (error) {
        if (handoff) handoff.status = 'failed';
        const failureKind = error.failureKind ?? classifyFailure(error).kind;
        const continuable = ['length', 'empty-output', 'timeout', 'quota', 'transport'].includes(failureKind) || agent.availability === 'offline';
        if (!continuable || safeError(error).includes('STOP_UNCONFIRMED')) {
          if (handoff) {
            handoff.routingError = safeError(error);
            await this.checkpoint();
          }
          throw error;
        }
        const snapshot = await this.worktrees.snapshot(task.workspace);
        const attempt = attempted.length;
        const failedModels = new Set([...(task.unavailableModels ?? [])]);
        if (attemptRouting?.selectedModel) {
          const catalog = this.modelCatalog() ? normalizeModelRegistry(this.modelCatalog()) : [];
          const ambiguousIds = catalog.ambiguousIds ?? new Set();
          const explicitConnectionId = attemptRouting.connectionId ?? agent.connectionId;
          if (!ambiguousIds.has(attemptRouting.selectedModel)) failedModels.add(attemptRouting.selectedModel);
          if (explicitConnectionId) failedModels.add(`${explicitConnectionId}::${attemptRouting.selectedModel}`);
        }
        const failedModelsList = [...failedModels];
        handoff = { id: randomUUID(), from: agent.id, to: null, attempt, role: task.role, actionId: task.actionId, workspace: task.workspace, snapshotHash: snapshot.hash, error: safeError(error), failureKind, finishReason: error.finishReason, usage: error.usage, failedModel: attemptRouting?.selectedModel, failureRouting: attemptRouting, unavailableModels: failedModelsList, at: new Date().toISOString(), status: 'waiting' };
        this.state.handoffs ??= []; this.state.handoffs.push(handoff);
        await atomicJson(path.join(this.store.directory, 'evidence', handoff.id, 'checkpoint.json'), { ...handoff, snapshot, goal: this.state.goal, prompt: task.prompt, latestAlignment: this.lastAlignment?.text });
        await this.checkpoint();
        await this.refreshPaidEligibility();
        let next;
        try { next = this.sharedWorker(task.role, task.capabilities ?? (task.role === 'decide' ? ['reason'] : []), [...new Set([...attempted, ...(task.excludeAgents ?? [])])], [...new Set([...attemptedIdentities, ...(task.excludeIdentities ?? [])])]); }
        catch (routingError) { handoff.status = 'failed'; handoff.routingError = safeError(routingError); await this.checkpoint(); throw routingError; }
        if ((await this.worktrees.snapshot(task.workspace)).hash !== snapshot.hash) throw new Error('Handoff workspace changed before takeover');
        if (task.role === 'build') {
          const action = this.state.actions.find(action => action.id === task.actionId);
          action.builderIdentities ??= [action.builderIdentity];
          for (const identity of identityLabelsOf(next)) if (!action.builderIdentities.includes(identity)) action.builderIdentities.push(identity);
          action.builderHistory ??= [action.builder]; action.builderHistory.push(next.id);
          action.builder = next.id; action.builderIdentity = next.identity ?? next.id;
        }
        handoff.to = next.id; handoff.status = 'resuming';
        this.state.sharedWorker = next.id;
        await this.checkpoint();
        const escalate = task.escalate === true || ['length', 'empty-output', 'timeout'].includes(failureKind);
        task = { ...task, unavailableModels: failedModels, escalate, prompt: `${task.prompt}\nHandoff: ${agent.id} failed with ${failureKind} after confirmed stop. Continue this SAME action in the preserved workspace; inspect existing partial changes, do not restart blindly. Previous error: ${handoff.error}. Snapshot: ${snapshot.hash}. Do not commit or schedule another task.` };
        agent = next;
      }
    }
  }

  async alignment(stage, observation, tree, action, enforce = true) {
    if (!this.commercial) return;
    await this.refreshPaidEligibility();
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
    const resolved = this.resolveAgentForTask(agent, task);
    agent = resolved.agent;
    const routing = resolved.routing;
    await task.onWorkerSelected?.(agent);
    const runKey = randomUUID();
    const artifactDir = path.join(this.store.directory, 'evidence', task.actionId ?? runKey);
    await mkdir(artifactDir, { recursive: true });
    // Recompute routing for whichever Worker is about to run, including any
    // handoff successor. A fail-closed RoutingError propagates as an ordinary
    // FAILED action and never marks the provider offline.
    if (routing) task.onRouting?.(routing);
    const abort = new AbortController();
    this.controller = abort;
    const started = Date.now();
    const launchIntent = { id: runKey, launchToken: runKey, worker: agent.id, role: task.role, actionId: task.actionId, workspace: task.workspace, status: 'preparing', startedAt: new Date().toISOString(), ...(routing ? { routing } : {}) };
    this.state.runs.push(launchIntent);
    await this.checkpoint(); // Durable before any Worker is spawned.
    let run;
    try {
      const selectedModel = routing?.selectedModel ?? task.model ?? agent.model;
      const catalog = this.modelCatalog();
      const modelEntry = catalog && selectedModel && normalizeModelRegistry(catalog).find(model => model.id === selectedModel
        && model.provider === agent.provider && (!model.connectionId || model.connectionId === (agent.connectionId ?? agent.id ?? agent.provider)));
      if (catalog && selectedModel && (!modelEntry || !modelEntry.eligible || modelEntry.prohibited)) throw new RoutingError(`Static model ${selectedModel} is not eligible for connection ${agent.connectionId ?? agent.id}`, 'INELIGIBLE_STATIC_MODEL');
      const securityRequired = task.security === true || task.capabilities?.includes('security') || task.requiredCapabilities?.includes('security');
      const requiredTier = securityRequired ? 'security' : (task.risk === 'high' || task.escalate === true) ? 'deep' : 'routine';
      const acceptableTiers = requiredTier === 'security' ? ['security'] : requiredTier === 'deep' ? ['deep', 'security'] : ['routine'];
      if (modelEntry && !acceptableTiers.includes(modelEntry.tier)) throw new RoutingError(`Static model ${selectedModel} does not satisfy required ${requiredTier} tier for ${task.role}`, 'NO_ELIGIBLE_MODEL');
      let paidApiAuthorization;
      if (agent.paidApi) {
        const paidEndpoint = agent.paidApi.endpoint?.replace(/\/$/, '');
        if (!selectedModel || !paidEndpoint || (this.modelCatalog() && (!modelEntry || !modelEntry.paid || modelEntry.endpoint.replace(/\/$/, '') !== paidEndpoint))) {
          const error = new Error(`Paid API authorization needed: connection ${agent.connectionId ?? agent.id}, model ${selectedModel ?? '(unspecified)'} is not explicitly registered as paid`);
          error.failureKind = 'authorization-needed';
          throw error;
        }
        paidApiAuthorization = await reservePaidApiRun({ stateDir: this.store.directory, connectionId: agent.connectionId ?? agent.id, modelId: selectedModel, endpoint: agent.paidApi.endpoint, project: this.repository, runId: runKey });
      } else if (modelEntry?.paid) {
        const error = new Error(`Paid API authorization needed: connection ${modelEntry.connectionId}, model ${selectedModel} is not configured as a paid connection`);
        error.failureKind = 'authorization-needed';
        throw error;
      }
      run = await agent.start({ ...task, model: routing?.selectedModel ?? task.model, project: this.repository, paidApiAuthorization, runKey, artifactDir, permissions: policyFor(task.role, this.state.permissions), timeoutMs: this.config.agentTimeoutMs ?? 300_000, signal: abort.signal, onEvent: event => {
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
    await this.refreshPaidEligibility();
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
    await this.refreshPaidEligibility();
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
      let activeBuilder = this.commercial ? this.sharedWorker('build', candidate.capabilities) : builder;
      action.builder = activeBuilder.id; action.builderIdentity = activeBuilder.identity ?? activeBuilder.id;
      const execute = this.commercial ? this.executeWithHandoff.bind(this) : this.execute.bind(this);
      // The builder's pre-dispatch risk is Host-computed from the validated
      // candidate, never the Worker's self-report. Routing only picks a model
      // for the already-selected Worker.
      let builderRouting;
      action.builderResult = await execute(activeBuilder, { role: 'build', actionId: id, capabilities: candidate.capabilities, risk: action.risk, onWorkerSelected: selected => {
        activeBuilder = selected;
        const identity = selected.identity ?? selected.id;
        action.builderHistory ??= [selected.id];
        action.builderIdentities ??= [];
        if (!action.builderHistory.includes(selected.id)) action.builderHistory.push(selected.id);
        for (const alias of identityLabelsOf(selected)) if (!action.builderIdentities.includes(alias)) action.builderIdentities.push(alias);
        action.builder = selected.id;
        action.builderIdentity = identity;
      }, onRouting: selection => { builderRouting = selection; }, workspace: tree.directory, outputFormat: this.commercial ? 'text' : undefined, prompt: `Goal: ${action.goal}\nProject goal: ${this.state.goal}\nCriteria: ${JSON.stringify(this.state.successCriteria)}\nDiagnosis: ${JSON.stringify(this.state.gaps)}\nAlignment feedback: ${this.lastAlignment?.text ?? ''}\nCurrent source evidence: ${JSON.stringify(this.lastObservation?.sources ?? {})}\nHost observation and live contracts: ${JSON.stringify({ ...this.lastObservation, sources: undefined, snapshot: { hash: this.lastObservation?.snapshot?.hash } })}\nPrevious review findings: ${JSON.stringify(previous?.reviews ?? [])}\nProtected files must not be changed: ${JSON.stringify(this.config.protectedPaths ?? [])}. Add deterministic regression tests for changed behavior; tests are source files and may be added unless explicitly listed as protected. Do not interpret a generic source-only instruction as prohibiting required regression tests. Modify source only beyond those tests. Check alignment during execution. If the route is wrong, report it rather than silently expanding scope. Host runs tests and commits after you stop.`, outputSchema: { summary: 'string', filesChanged: ['string'] } });
      if (builderRouting) action.routing = builderRouting;
      if (this.afterBuild) {
        const evidence = await this.afterBuild(clone(action), tree.directory);
        if (evidence) this.state.evidence.push({ kind: 'environment-event', actionId: id, ...clone(evidence) });
      }
      if ((await this.worktrees.snapshot(tree.directory)).hash === beforeBuild.hash) {
        action.phase = 'NO_CHANGE'; action.finishedAt = new Date().toISOString();
        this.state.failures.push({ actionId: id, worker: action.builder, error: 'No source change; no commit or accepted progress', at: action.finishedAt });
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
      this.state.failures.push({ actionId: id, worker: action.builder, error: action.error, at: new Date().toISOString() });
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
    await this.refreshPaidEligibility();
    if ((action.reviewAttempts ?? 0) >= (this.config.maxReviewAttempts ?? 3)) {
      action.phase = 'HALTED'; await this.checkpoint(); throw new Error('Independent review retry budget exhausted');
    }
    action.reviewAttempts = (action.reviewAttempts ?? 0) + 1;
    if ((await this.worktrees.snapshot(action.worktree.directory)).hash !== action.snapshot.hash) throw new Error('Frozen Builder worktree changed');
    // Allocate the constrained security capability first so a general review
    // cannot consume the only available security reviewer.
    const required = action.risk === 'high' ? ['security', 'review'] : ['review'];
    action.reviews ??= [];
    action.reservedReviewerIds ??= [];
    action.reservedReviewerIdentities ??= [];
    const builderIds = new Set([action.builder, ...(action.builderHistory ?? [])].filter(Boolean));
    const builderIdentitySet = new Set([action.builderIdentity, ...(action.builderIdentities ?? [])].filter(Boolean));
    for (const id of builderIds) for (const identity of identitiesOf(this.registry.agents.get(id))) builderIdentitySet.add(identity);
    const usedReviewerIds = new Set([...action.reservedReviewerIds, ...action.reviews.map(review => review.reviewer)].filter(Boolean));
    const usedReviewerIdentities = new Set(action.reservedReviewerIdentities);
    for (const id of usedReviewerIds) for (const identity of identitiesOf(this.registry.agents.get(id))) usedReviewerIdentities.add(identity);
    action.phase = 'REVIEWING';
    await this.event('REVIEW', { actionId: action.id });
    let activeReviewer;
    let activeTree, activeSnapshot;
    try {
      for (const capability of required.slice(action.reviews.length)) {
        const excludedIds = [...new Set([...builderIds, ...usedReviewerIds])];
        const excludedIdentities = [...new Set([...builderIdentitySet, ...usedReviewerIdentities])];
        const reviewer = this.registry.select({ role: 'review', capabilities: ['review', capability], risk: action.risk, exclude: excludedIds, excludeIdentities: excludedIdentities }, this.state.agentPerformance);
        let actualReviewer;
        let routing;
        const tree = await this.worktrees.create(randomUUID(), 'review', action.commit);
        activeTree = tree;
        if (!action.committedTests) action.committedTests = await this.tests(tree.directory, `${action.id}-committed`);
        if (this.commercial && !action.commercialReview) action.commercialReview = await this.alignment('verify', { ...this.lastObservation, tests: testSummary(action.committedTests) }, tree, action, false);
        const initial = await this.worktrees.snapshot(tree.directory);
        activeSnapshot = initial;
        const actionDiff = action.actionDiff ?? await this.worktrees.diff(action.worktree);
        const report = await this.execute(reviewer, { role: 'review', actionId: action.id, capabilities: ['review', capability], requiredCapabilities: [capability], security: capability === 'security', risk: action.risk, workspace: tree.directory, outputSchema: REVIEW_SHAPE,
          excludeAgents: excludedIds, excludeIdentities: excludedIdentities,
          validateSelected: selected => {
            const selectedIdentities = identitiesOf(selected);
            if (!selected.roles.includes('review') || !selected.capabilities.includes('review') || !selected.capabilities.includes(capability)
              || excludedIds.includes(selected.id) || selectedIdentities.some(identity => excludedIdentities.includes(identity))) {
              throw new Error(`Independent ${capability} reviewer selection violated role, capability, or identity exclusions`);
            }
          },
          onWorkerSelected: async selected => {
            actualReviewer = selected;
            activeReviewer = selected.id;
            usedReviewerIds.add(selected.id);
            for (const identity of identitiesOf(selected)) usedReviewerIdentities.add(identity);
            if (!action.reservedReviewerIds.includes(selected.id)) action.reservedReviewerIds.push(selected.id);
            for (const identity of identityLabelsOf(selected)) if (!action.reservedReviewerIdentities.includes(identity)) action.reservedReviewerIdentities.push(identity);
            await this.checkpoint();
          },
          onRouting: selection => { routing = selection; },
          prompt: `Independently perform ${required[action.reviews.length]} review of this candidate commit ${action.commit}. Source access is read-only. Do not accept Builder claims as evidence.\nGoal: ${action.goal}\nSuccess criteria: ${JSON.stringify(this.state.successCriteria)}\nActual host test results on Builder tree: ${JSON.stringify(action.tests)}\nActual host tests on clean committed tree: ${JSON.stringify(action.committedTests)}\nCurrent action delta from its dispatch base:\n${actionDiff}\nCumulative candidate diff from accepted baseline (includes inherited rejected work):\n${action.diff}\nApply action-specific file scope to the current action delta, not inherited changes. Evaluate the ENTIRE cumulative candidate against project criteria and protected policy.\nProtected files intact: ${action.protectedIntact}\nReject failures, regressions, missing evidence or blocking risks. Do not modify files.`,
        });
        if (!actualReviewer || !identitiesOf(actualReviewer).length || builderIds.has(actualReviewer.id) || identitiesOf(actualReviewer).some(identity => builderIdentitySet.has(identity))
          || action.reviews.some(prior => prior.reviewer === actualReviewer.id || identitiesOf(this.registry.agents.get(prior.reviewer)).some(identity => identitiesOf(actualReviewer).includes(identity)))) {
          throw new Error('Actual reviewer failed independence validation before review binding');
        }
        if (!['pass', 'reject', 'needs_more_evidence'].includes(report.verdict) || typeof report.reason !== 'string' || !Array.isArray(report.evidence) || !report.evidence.length || !Array.isArray(report.blockingRisks)) throw new Error('Invalid independent review report');
        if ((await this.worktrees.snapshot(tree.directory)).hash !== initial.hash || (await this.worktrees.snapshot(action.worktree.directory)).hash !== action.snapshot.hash) throw new Error('Reviewer modified source or frozen Builder version');
        const boundReport = { ...report, reviewer: actualReviewer.id, capability, actionId: action.id, commit: action.commit, snapshotHash: action.snapshot.hash, worktree: tree,
          ...(actualReviewer.connectionId ? { connectionId: actualReviewer.connectionId } : {}), ...(routing ? { routing } : {}) };
        action.reviews.push(boundReport); this.state.reviews.push(boundReport);
        await atomicJson(path.join(this.store.directory, 'evidence', action.id, `review-${actualReviewer.id}.json`), boundReport);
        await this.checkpoint();
        await this.worktrees.remove(tree);
        activeTree = null;
      }
      const reviewIdentities = new Set();
      const reviewersIndependent = action.reviews.length === required.length && action.reviews.every((review, index) => {
        const reviewer = this.registry.agents.get(review.reviewer);
        const aliases = identitiesOf(reviewer ?? { id: review.reviewer });
        if (!reviewer || review.capability !== required[index] || builderIds.has(review.reviewer)
          || aliases.some(identity => builderIdentitySet.has(identity))
          || aliases.some(identity => reviewIdentities.has(identity))) return false;
        aliases.forEach(identity => reviewIdentities.add(identity));
        return true;
      });
      const pass = (!this.commercial || action.commercialReview?.audit.outcome === 'PASS') && action.protectedIntact === true && action.tests.every(test => test.passed) && action.committedTests.every(test => test.passed) && reviewersIndependent && action.reviews.every(review => review.verdict === 'pass' && review.blockingRisks.length === 0);
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
