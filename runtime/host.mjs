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
        if (loaded) { this.projectConfig = loaded; this.mode = 'project'; }
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
      native: this.nativeSession ? this.nativeSession.describe() : { state: 'idle', lastError: null },
      projectRunning: this.projectRuntime?.running ?? false,
      projectWorld: this.projectRuntime?.view() ?? null,
    };
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
    const merged = { ...this.nativeOptions, ...options };
    merged.artifactDir = merged.artifactDir ?? (this.stateDir ? path.join(this.stateDir, 'native-sessions') : null);
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
    this.projectRuntime = this.ctx.autonomousControl.createProject(this.projectConfig, { agents });
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
