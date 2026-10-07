import { EventEmitter } from 'node:events';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import * as control from '../plugins/autonomous-control-loop/index.js';
import { NativeSession, createNativeSession } from './native-session.mjs';
import { createAgentAdapter } from './adapters.mjs';
import { ProjectRuntime } from './project.mjs';
import { loadProjectConfig, saveProjectConfig, mergeAgentConfigs, DEFAULT_HOST_AGENTS, sanitizeProjectConfig } from './project-config.mjs';
import { atomicJson } from './store.mjs';
import { redact } from './process.mjs';

const HOST_STATE_FILE = 'dsh-web-host.json';

export class WebHost extends EventEmitter {
  constructor({ hostAgents = DEFAULT_HOST_AGENTS, stateDir, nativeOptions = {} } = {}) {
    super();
    this.hostAgents = hostAgents;
    this.stateDir = stateDir ? path.resolve(stateDir) : null;
    this.nativeOptions = nativeOptions;
    this.mode = nativeOptions.defaultMode ?? 'native';
    this.projectConfig = null;
    this.nativeSession = null;
    this.projectRuntime = null;
    this.fiber = null;
    this.ctx = null;
    this.switching = false;
    this.hostStateFile = this.stateDir ? path.join(this.stateDir, HOST_STATE_FILE) : null;
  }

  async init() {
    if (this.stateDir) await mkdir(this.stateDir, { recursive: true });
    if (this.stateDir) {
      try {
        const loaded = await loadProjectConfig(this.stateDir);
        if (loaded) {
          this.projectConfig = loaded;
          this.mode = 'project';
          try { await this._loadProjectRuntime(); }
          catch (error) { this.emit('project-error', redact(error.message)); }
        }
      } catch { /* ignore invalid persisted config; keep native mode */ }
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
      projectRunning: this.projectRuntime?.running ?? false,
      projectWorld: this.projectRuntime?.view() ?? null,
    };
  }

  _nativeAllowlist() {
    const list = [];
    for (const [alias, agent] of Object.entries(this.hostAgents)) {
      if (agent.enabled !== true) continue;
      if (typeof agent.provider === 'string' && typeof agent.model === 'string') {
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
      return this.view();
    } finally { this.switching = false; }
  }

  async _disposeCurrentMode() {
    if (this.nativeSession) { await this.nativeSession.dispose(); this.nativeSession = null; }
    if (this.projectRuntime) { await this.projectRuntime.close(); this.projectRuntime = null; }
  }

  async _saveHostState() {
    if (!this.hostStateFile) return;
    await atomicJson(this.hostStateFile, { mode: this.mode, projectConfigured: Boolean(this.projectConfig), updatedAt: new Date().toISOString() });
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
    // Browser requests may only select provider/model/workspace; never accept
    // executable, argsPrefix, env, profile, permissions or paid overrides.
    const requestedProvider = typeof options.provider === 'string' ? options.provider.trim() : '';
    const requestedModel = typeof options.model === 'string' ? options.model.trim() : '';
    let selected;
    if (requestedProvider && requestedModel) {
      selected = allowlist.find(a => a.provider === requestedProvider && a.model === requestedModel);
      if (!selected) throw new Error(`Provider/model not in enabled Host allowlist: ${requestedProvider}/${requestedModel}`);
    } else {
      selected = allowlist[0];
    }
    const merged = {
      workspace: typeof options.workspace === 'string' ? options.workspace.trim() : (this.nativeOptions.workspace ?? process.cwd()),
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
      this.nativeSession = null;
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
    const saved = await saveProjectConfig(this.stateDir ?? config.stateDir, config);
    this.projectConfig = await loadProjectConfig(path.dirname(saved));
    if (this.mode !== 'project') await this.setMode('project');
    await this._saveHostState();
    this.emit('mode', this.view());
    return sanitizeProjectConfig(this.projectConfig);
  }

  _resolveWorkerAlias(worker, agentEntries) {
    if (!worker || agentEntries[worker]) return worker;
    const transportMap = { opencode: 'opencode', codex: 'codex', pi: 'pi', dsh: 'dsh' };
    const transport = transportMap[worker];
    if (!transport) return worker;
    const match = Object.entries(agentEntries).find(([, options]) => options.enabled !== false && (options.transport ?? options.id) === transport);
    return match ? match[0] : worker;
  }

  async _loadProjectRuntime() {
    if (!this.projectConfig) throw new Error('No project configuration');
    if (this.ctx) { await this.fiber.dispose(); this.ctx = null; this.fiber = null; }
    this.ctx = new Context();
    this.fiber = this.ctx.plugin(control);
    await new Promise(resolve => setImmediate(resolve));
    const agentEntries = mergeAgentConfigs(this.projectConfig.agents, this.hostAgents);
    const agents = Object.entries(agentEntries).map(([alias, options]) => {
      const settings = { ...options, id: options.id ?? alias, connectionId: options.connectionId ?? alias };
      return createAgentAdapter(settings.transport ?? alias, settings);
    });
    const runtimeConfig = { ...this.projectConfig };
    if (runtimeConfig.commercialLoop?.enabled) {
      const resolvedWorker = this._resolveWorkerAlias(runtimeConfig.commercialLoop.worker, agentEntries);
      runtimeConfig.commercialLoop = { ...runtimeConfig.commercialLoop, worker: resolvedWorker };
    }
    this.projectRuntime = this.ctx.autonomousControl.createProject(runtimeConfig, { agents });
    this.projectRuntime.on('state', view => this.emit('project-state', view));
    this.projectRuntime.on('run', event => this.emit('project-run', event));
    this.projectRuntime.on('loop-error', error => this.emit('project-error', error));
    await this.projectRuntime.initialize();
  }

  async loadProjectFromState() {
    this._assertNotSwitching();
    if (!this.stateDir) throw new Error('No stateDir configured');
    const config = await loadProjectConfig(this.stateDir);
    if (!config) throw new Error('No saved project configuration');
    this.projectConfig = config;
    this.mode = 'project';
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
    if (!this.projectRuntime) throw new Error('No project runtime');
    return this.projectRuntime.pause();
  }

  async cancelProject() {
    if (!this.projectRuntime) throw new Error('No project runtime');
    return await this.projectRuntime.cancel();
  }

  async close() {
    this._assertNotSwitching();
    await this._disposeCurrentMode();
    if (this.fiber) { await this.fiber.dispose(); this.fiber = null; this.ctx = null; }
  }
}
