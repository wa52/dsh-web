import { EventEmitter } from 'node:events';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import * as control from '../plugins/autonomous-control-loop/index.js';
import { NativeSession, createNativeSession } from './native-session.mjs';
import { createAgentAdapter } from './adapters.mjs';
import { ProjectRuntime } from './project.mjs';
import { loadProjectConfig, saveProjectConfig, mergeAgentConfigs, DEFAULT_HOST_AGENTS, sanitizeProjectConfig, validateBrowserProjectSetup } from './project-config.mjs';
import { atomicJson } from './store.mjs';
import { redact } from './process.mjs';

const HOST_STATE_FILE = 'dsh-web-host.json';

function isLaunchablePaidConnection(alias, options) {
  if (!options?.paidApi) return true;
  if ((options.transport ?? alias) !== 'opencode') return false;
  const endpoint = options.paidApi.endpoint?.replace(/\/$/, '');
  const baseURL = options.openCodeProvider?.baseURL?.replace(/\/$/, '');
  return Boolean(endpoint && baseURL && endpoint === baseURL);
}

export class WebHost extends EventEmitter {
  constructor({ hostAgents = DEFAULT_HOST_AGENTS, hostModels, stateDir, nativeOptions = {} } = {}) {
    super();
    this.hostAgents = hostAgents;
    this.hostModels = hostModels === undefined ? undefined : structuredClone(hostModels);
    this.stateDir = stateDir ? path.resolve(stateDir) : null;
    this.nativeOptions = nativeOptions;
    this.mode = nativeOptions.defaultMode ?? 'native';
    this.projectConfig = null;
    this.nativeSession = null;
    this.projectRuntime = null;
    this.fiber = null;
    this.ctx = null;
    this.switching = false;
    this.lastProjectError = null;
    this.on('project-error', error => {
      this.lastProjectError = redact(typeof error === 'string' ? error : error?.message ?? String(error));
    });
    this.hostStateFile = this.stateDir ? path.join(this.stateDir, HOST_STATE_FILE) : null;
  }

  async init() {
    if (this.stateDir) await mkdir(this.stateDir, { recursive: true });
    if (this.stateDir) {
      try {
        const hostState = await this._readHostState();
        const loaded = await loadProjectConfig(hostState?.projectStateDir ?? this.stateDir);
        if (loaded) {
          this.projectConfig = loaded;
          this.mode = 'project';
          try { await this._loadProjectRuntime(); }
          catch (error) { this.emit('project-error', redact(error.message)); }
        }
      } catch (error) { this.emit('project-error', `Saved project configuration could not be loaded: ${redact(error.message)}. Correct the setup and save again.`); }
    }
    this.emit('mode', this.view());
    return this.view();
  }

  view() {
    return {
      mode: this.mode,
      switching: this.switching,
      projectConfigured: Boolean(this.projectConfig),
      projectConfig: this.projectConfig ? sanitizeProjectConfig(this.projectConfig) : null,
      nativeConfigured: this._isNativeConfigured(),
      native: this.nativeSession ? this.nativeSession.describe() : { state: 'idle', lastError: null },
      nativeChoices: this._nativeAllowlist(),
      nativeWorkspace: path.resolve(this.nativeOptions.workspace ?? process.cwd()),
      projectRunning: this.projectRuntime?.running ?? false,
      projectError: this.lastProjectError,
      projectWorld: this.projectRuntime?.view() ?? null,
    };
  }

  _nativeAllowlist() {
    if (this.nativeOptions.enabled === false) return [];
    const list = [];
    for (const [alias, agent] of Object.entries(this.hostAgents)) {
      if (agent.enabled !== true || (agent.transport ?? alias) !== 'dsh' || agent.paidApi) continue;
      if (typeof agent.provider === 'string' && agent.provider.trim() && typeof agent.model === 'string' && agent.model.trim()) {
        list.push({ alias, provider: agent.provider, model: agent.model });
      }
    }
    return list;
  }

  _isNativeConfigured() {
    return this._nativeAllowlist().length > 0;
  }

  _assertNotSwitching() {
    if (this.switching) throw new Error('Mode switch already in progress');
  }

  _isBusy() {
    if (this.nativeSession?.state === 'streaming' || this.nativeSession?.state === 'connecting') return true;
    if (this.projectRuntime?.running) return true;
    return false;
  }

  async setMode(mode) {
    this._assertNotSwitching();
    if (mode !== 'native' && mode !== 'project') throw new Error('Mode must be native or project');
    if (this.mode === mode) return this.view();
    if (this._isBusy()) throw Object.assign(new Error('Cannot switch modes while work is running'), { code: 'RUNNING' });
    this.switching = true;
    try {
      await this._disposeCurrentMode();
      this.mode = mode;
      if (mode === 'project' && this.projectConfig && !this.projectRuntime) await this._loadProjectRuntime();
      this.emit('mode', this.view());
    } finally { this.switching = false; this.emit('mode', this.view()); }
    return this.view();
  }

  async _disposeCurrentMode() {
    if (this.nativeSession) { await this.nativeSession.dispose(); this.nativeSession = null; }
    if (this.projectRuntime) { await this.projectRuntime.close(); this.projectRuntime = null; }
  }

  async _saveHostState() {
    if (!this.hostStateFile) return;
    await atomicJson(this.hostStateFile, {
      mode: this.mode,
      projectConfigured: Boolean(this.projectConfig),
      projectStateDir: this.projectConfig?.stateDir,
      updatedAt: new Date().toISOString(),
    });
  }

  async _readHostState() {
    if (!this.hostStateFile) return null;
    try { return JSON.parse(await readFile(this.hostStateFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async startNativeSession(options = {}) {
    this._assertNotSwitching();
    if (this.mode !== 'native') throw new Error('Not in native conversation mode');
    if (this.nativeSession) {
      if (this.nativeSession.state === 'streaming' || this.nativeSession.state === 'connecting') return this.nativeSession.describe();
      await this.nativeSession.dispose();
    }
    const allowlist = this._nativeAllowlist();
    if (!allowlist.length) throw new Error('Native conversation mode is not configured: no enabled Host provider/model allowlist');
    // Browser requests may only select provider/model; launch state is Host-owned.
    const requestedProvider = typeof options.provider === 'string' ? options.provider.trim() : '';
    const requestedModel = typeof options.model === 'string' ? options.model.trim() : '';
    let selected;
    if (Boolean(requestedProvider) !== Boolean(requestedModel)) throw new Error('Select both provider and model from the enabled Host allowlist');
    if (requestedProvider && requestedModel) {
      selected = allowlist.find(a => a.provider === requestedProvider && a.model === requestedModel);
      if (!selected) throw new Error(`Provider/model not in enabled Host allowlist: ${requestedProvider}/${requestedModel}`);
    } else {
      selected = allowlist[0];
    }
    const merged = {
      workspace: this.nativeOptions.workspace ?? process.cwd(),
      provider: selected.provider,
      model: selected.model,
      executable: this.nativeOptions.executable,
      argsPrefix: this.nativeOptions.argsPrefix,
      env: this.nativeOptions.env,
      profile: this.nativeOptions.profile ?? 'sdk',
      artifactDir: this.nativeOptions.artifactDir ?? (this.stateDir ? path.join(this.stateDir, 'native-sessions') : null),
    };
    this.nativeSession = createNativeSession(merged);
    this._wireNativeSession();
    try { await this.nativeSession.start(); }
    catch (error) {
      // Retain failed state and its cleanup promise: switching must still
      // confirm stop, especially when SDK initialization or disposal fails.
      throw error;
    }
    await this._saveHostState();
    return this.nativeSession.describe();
  }

  _wireNativeSession() {
    const session = this.nativeSession;
    for (const event of ['event', 'message', 'done', 'error', 'stopped', 'ready', 'log', 'close']) {
      session.on(event, data => this.emit('native-' + event, data));
    }
  }

  async nativeChat(prompt) {
    this._assertNotSwitching();
    if (this.mode !== 'native') throw new Error('Not in native conversation mode');
    if (!this.nativeSession || this.nativeSession.state === 'error' || this.nativeSession.state === 'stopped') {
      await this.startNativeSession();
    }
    return await this.nativeSession.send(prompt);
  }

  async stopNative() {
    this._assertNotSwitching();
    if (!this.nativeSession) return { state: 'idle' };
    return await this.nativeSession.stop();
  }

  async setupProject(config) {
    this._assertNotSwitching();
    if (this._isBusy()) throw Object.assign(new Error('Cannot change project setup while work is running'), { code: 'RUNNING' });
    validateBrowserProjectSetup(config);
    const permissions = { read: true, write: true, shell: false, network: false, gitCommit: false };
    if (config.permissions !== undefined) {
      if (!config.permissions || typeof config.permissions !== 'object' || Array.isArray(config.permissions)
        || Object.entries(config.permissions).some(([key, value]) => !Object.hasOwn(permissions, key) || value !== permissions[key])) {
        throw new Error('permissions are Host-owned; Web setup cannot change execution policy');
      }
    }
    config = { ...config, permissions };
    const saved = await saveProjectConfig(config.stateDir, config);
    if (this.projectRuntime) { await this.projectRuntime.close(); this.projectRuntime = null; }
    this.projectConfig = await loadProjectConfig(path.dirname(saved));
    this.lastProjectError = null;
    if (this.mode !== 'project') await this.setMode('project');
    else await this._loadProjectRuntime();
    await this._saveHostState();
    this.emit('mode', this.view());
    return sanitizeProjectConfig(this.projectConfig);
  }

  _resolveWorkerAlias(worker, agentEntries) {
    if (worker === 'auto') {
      const match = Object.entries(agentEntries).find(([, options]) => !options.paidApi && (!options.roles || options.roles.includes('build')));
      if (!match) throw new Error('No enabled Host builder account; enable an authorized connection in --host-agents');
      return match[1].id ?? match[0];
    }
    if (!worker) return worker;
    if (agentEntries[worker]) return agentEntries[worker].id ?? worker;
    const transportMap = { opencode: 'opencode', codex: 'codex', pi: 'pi', dsh: 'dsh' };
    const transport = transportMap[worker];
    if (!transport) return worker;
    const match = Object.entries(agentEntries).find(([, options]) => options.enabled !== false && (options.transport ?? options.id) === transport);
    return match ? (match[1].id ?? match[0]) : worker;
  }

  async _loadProjectRuntime() {
    if (!this.projectConfig) throw new Error('No project configuration');
    if (this.ctx) { await this.fiber.dispose(); this.ctx = null; this.fiber = null; }
    this.ctx = new Context();
    this.fiber = this.ctx.plugin(control);
    await new Promise(resolve => setImmediate(resolve));
    let agentEntries = mergeAgentConfigs(this.projectConfig.agents, this.hostAgents);
    const runtimeConfig = { ...this.projectConfig };
    if (runtimeConfig.commercialLoop?.enabled) {
      const resolvedWorker = this._resolveWorkerAlias(runtimeConfig.commercialLoop.worker, agentEntries);
      runtimeConfig.commercialLoop = { ...runtimeConfig.commercialLoop, worker: resolvedWorker };
    }
    agentEntries = Object.fromEntries(Object.entries(agentEntries).filter(([alias, options]) => {
      if (isLaunchablePaidConnection(alias, options)) return true;
      const id = options.id ?? alias;
      if (runtimeConfig.commercialLoop?.worker === id || runtimeConfig.commercialLoop?.worker === alias || runtimeConfig.decisionAgent === id || runtimeConfig.decisionAgent === alias) return true;
      return false;
    }));
    const agents = Object.entries(agentEntries).map(([alias, options]) => {
      const settings = { ...options, id: options.id ?? alias, connectionId: options.connectionId ?? alias };
      return createAgentAdapter(settings.transport ?? alias, settings);
    });
    // Inject trusted routing only after Web validation. Models for deselected or
    // disabled connections must not become unknown/usable runtime connections.
    if (this.hostModels !== undefined) {
      const models = Array.isArray(this.hostModels) ? this.hostModels : this.hostModels?.models;
      if (!Array.isArray(models)) throw new Error('Host models must be an array or an object with a models array');
      const connections = new Set(Object.entries(agentEntries).map(([alias, options]) => options.connectionId ?? alias));
      const hostConnections = new Set(Object.entries(this.hostAgents).map(([alias, options]) => options.connectionId ?? alias));
      runtimeConfig.models = structuredClone(models.filter(model => !model?.connectionId
        || !hostConnections.has(model.connectionId) || connections.has(model.connectionId)));
      if (models.length && !runtimeConfig.models.length && agents.length) {
        throw new Error('No Host models remain for selected connections; configure their model routing before starting the project');
      }
    }
    this.projectRuntime = this.ctx.autonomousControl.createProject(runtimeConfig, { agents });
    this.projectRuntime.on('state', view => this.emit('project-state', view));
    this.projectRuntime.on('run', event => this.emit('project-run', event));
    this.projectRuntime.on('loop-error', error => this.emit('project-error', error));
    await this.projectRuntime.initialize();
  }

  async loadProjectFromState() {
    this._assertNotSwitching();
    if (this._isBusy()) throw new Error('Cannot reload project configuration while work is running');
    if (!this.stateDir) throw new Error('No stateDir configured');
    const hostState = await this._readHostState();
    const config = await loadProjectConfig(hostState?.projectStateDir ?? this.stateDir);
    if (!config) throw new Error('No saved project configuration');
    this.projectConfig = config;
    if (this.mode !== 'project') await this.setMode('project');
    if (!this.projectRuntime) {
      try { await this._loadProjectRuntime(); }
      catch (error) { this.emit('project-error', redact(error.message)); }
    }
    await this._saveHostState();
    this.emit('mode', this.view());
    return sanitizeProjectConfig(config);
  }

  async startProjectLoop(maxActions) {
    this._assertNotSwitching();
    if (this.mode !== 'project') throw new Error('Not in project mode');
    if (!this.projectRuntime) await this._loadProjectRuntime();
    if (this.projectRuntime.running) throw new Error('Project loop is already running');
    void this.projectRuntime.start({ maxActions }).catch(error => this.emit('project-error', error));
    return this.projectRuntime.view();
  }

  async pauseProject() {
    this._assertNotSwitching();
    if (this.mode !== 'project') throw new Error('Not in project mode');
    if (!this.projectRuntime) throw new Error('No project runtime');
    return this.projectRuntime.pause();
  }

  async cancelProject() {
    this._assertNotSwitching();
    if (this.mode !== 'project') throw new Error('Not in project mode');
    if (!this.projectRuntime) throw new Error('No project runtime');
    return await this.projectRuntime.cancel();
  }

  async close() {
    this._assertNotSwitching();
    await this._disposeCurrentMode();
    if (this.fiber) { await this.fiber.dispose(); this.fiber = null; this.ctx = null; }
  }
}
