import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { launch, killTree, processFingerprint, redact } from './process.mjs';
const require = createRequire(import.meta.url);

const textOf = content => (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');

/** Persistent native DeepSeek Harness conversation session, separate from ProjectRuntime. */
export class NativeSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.on('error', () => {});
    this.workspace = options.workspace ?? process.cwd();
    this.provider = options.provider;
    this.model = options.model;
    this.executable = options.executable;
    this.argsPrefix = options.argsPrefix ?? [];
    this.profile = options.profile ?? 'sdk';
    this.sessionId = options.sessionId ?? randomUUID();
    this.artifactDir = options.artifactDir;
    this.env = options.env ?? {};
    this.maxHistory = options.maxHistory ?? 100;
    this.history = [];
    this.state = 'idle'; // idle | connecting | streaming | stopped | error
    this.lastError = null;
    this.child = null;
    this.pending = '';
    this.closed = false;
    this.disposePromise = null;
    this.fingerprint = null;
    this._initialized = false;
    this._requestId = 1;
    this._childClosed = null;
  }

  static resolveSdkBin() {
    try {
      const pkg = require.resolve('@deepseek-ai/dsh/package.json');
      return path.join(path.dirname(pkg), 'lib/bin.js');
    } catch {
      return null;
    }
  }

  describe() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      provider: this.provider,
      model: this.model,
      profile: this.profile,
      workspace: this.workspace,
      turns: this.history.length,
      lastError: this.lastError,
    };
  }

  async start() {
    if (this.child) throw new Error('Native session already started');
    const bin = NativeSession.resolveSdkBin();
    if (!this.executable && !bin) {
      this.state = 'error';
      this.lastError = 'DeepSeek Harness SDK is not installed; run npm install';
      this.emit('error', { message: this.lastError });
      throw new Error(this.lastError);
    }
    if (this.executable && !existsSync(this.executable)) {
      this.state = 'error';
      this.lastError = `Native executable not found: ${this.executable}`;
      this.emit('error', { message: this.lastError });
      throw new Error(this.lastError);
    }
    const command = this.executable ?? process.execPath;
    const args = this.executable ? [...this.argsPrefix, '--profile', this.profile] : [bin, '--profile', this.profile];
    this.state = 'connecting';
    this.lastError = null;
    this._initialized = false;
    if (this.artifactDir) await mkdir(this.artifactDir, { recursive: true });
    const child = launch(command, args, {
      cwd: this.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...this.env },
    }, this.sessionId);
    this.child = child;
    this._childClosed = new Promise(resolve => child.once('close', resolve));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this._onStdout(chunk));
    child.stderr.on('data', chunk => this.emit('log', { stream: 'stderr', text: redact(chunk) }));
    child.on('error', error => this._fail(error));
    child.stdin.on('error', error => { if (!this.closed) this._fail(error); });
    child.on('close', code => {
      if (!this.closed && this.state !== 'stopped' && this.state !== 'error') {
        this._fail(new Error(`DSH SDK exited ${code} before the session was stopped; check Host provider/model configuration and SDK startup`));
      }
      this.emit('close', { code, state: this.state });
    });
    try {
      if (!child.pid) throw new Error('Cannot spawn DSH SDK');
      this.fingerprint = await processFingerprint(child.pid);
      this._send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: this.workspace, provider: this.provider, model: this.model } });
      await this._expectInitialized();
      this.state = 'idle';
      this.emit('ready', this.describe());
      return this.describe();
    } catch (error) {
      this._fail(error, false);
      await this.dispose();
      throw error;
    }
  }

  async _expectInitialized(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === 'error') throw new Error(this.lastError ?? 'DSH SDK initialization failed');
      if (this.closed) throw new Error('DSH SDK stopped during initialization');
      if (this._initialized) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('DSH SDK initialization timed out');
  }

  _send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Native session is not connected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  _onStdout(chunk) {
    this.pending += chunk;
    let index;
    while ((index = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, index).replace(/\r$/, ''); this.pending = this.pending.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch (error) { this.emit('log', { stream: 'stdout', text: line }); continue; }
      try { this._onFrame(frame); } catch (error) { this._fail(error); }
    }
  }

  _onFrame(frame) {
    if (frame.error) {
      this._fail(new Error(frame.error.message ?? 'DSH SDK error'));
      return;
    }
    if (frame.id === 1) {
      this._initialized = true;
      return;
    }
    if (!this.closed && frame.method === 'session.event' && frame.params?.sessionId === this.sessionId) {
      const event = frame.params.event;
      if (!event || typeof event.type !== 'string') return;
      this.emit('event', { type: event.type });
      if (event.type === 'assistant/message') {
        const text = redact(textOf(event.data?.message?.content));
        this._currentText = (this._currentText ?? '') + text;
        this.emit('message', { text, delta: text });
      }
      if (event.type === 'turn/end') {
        const reason = event.data?.reason?.kind ?? event.data?.reason;
        const text = this._currentText ?? '';
        this._currentText = '';
        if (reason !== 'completed') {
          this._fail(new Error(`DSH turn ended ${reason}; check Host model authorization and SDK logs`));
          return;
        }
        this.history.push({ role: 'assistant', content: text });
        this._trimHistory();
        this.state = 'idle';
        this.emit('done', { text, reason });
      }
    }
  }

  _fail(error, dispose = true) {
    if (this.state === 'error') return;
    this.state = 'error';
    this.lastError = redact(error.message);
    this.emit('error', { message: this.lastError, name: error.name });
    if (dispose) void this.dispose().catch(error => {
      this.lastError = `${this.lastError}; stop failed: ${redact(error.message)}`;
      this.emit('error', { message: this.lastError });
    });
  }

  async send(prompt) {
    if (this.state === 'error') throw new Error(`Native session error: ${this.lastError}`);
    if (this.state === 'connecting') await this._expectInitialized();
    if (this.state === 'streaming') throw new Error('Native session is already streaming; stop it first');
    if (!this.child || this.closed || this.state === 'stopped') throw new Error('Native session is not started');
    this.history.push({ role: 'user', content: prompt });
    this._trimHistory();
    this._currentText = '';
    this.state = 'streaming';
    try { this._send({ jsonrpc: '2.0', id: ++this._requestId, method: 'session/prompt', params: { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text: prompt }] } }); }
    catch (error) { this._fail(error); throw error; }
    return this.describe();
  }

  _trimHistory() {
    while (this.history.length > this.maxHistory) this.history.shift();
  }

  async stop() {
    if (!this.child) return this.describe();
    await this.dispose();
    return this.describe();
  }

  async _waitForExit(pid, fingerprint, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await processFingerprint(pid);
      if (!current || current !== fingerprint) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Native session descendant processes did not stop in time');
  }

  async dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      this.closed = true;
      const child = this.child;
      if (child) {
        const fingerprint = this.fingerprint;
        const alreadyExited = child.exitCode !== null || child.signalCode !== null;
        if (!alreadyExited) {
          try { await killTree(child); }
          catch (error) {
            const stillThere = fingerprint && (await processFingerprint(child.pid));
            if (stillThere) throw error;
          }
        }
        // Capture close at spawn, including launchers that already exited.
        let timer;
        try {
          await Promise.race([this._childClosed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Native SDK stop timed out; cannot switch modes until its guarded process tree has stopped')), 5000);
          })]);
        } finally { clearTimeout(timer); }
        if (fingerprint) await this._waitForExit(child.pid, fingerprint);
      }
      this.child = null;
      if (this.state !== 'error') this.state = 'stopped';
      this.emit('stopped', this.describe());
    })();
    return this.disposePromise;
  }
}

/** Factory for creating native sessions from sanitized configuration. */
export function createNativeSession(options) {
  const model = options.model?.trim();
  const provider = options.provider?.trim();
  if (!provider) throw new Error('Native provider is required');
  if (!model) throw new Error('Native model is required');
  if (!/^[^/\s]+\/[^/\s]+$|^[^/\s]+$/.test(model)) throw new Error('Invalid model identifier');
  if (!/^[a-z0-9_-]+$/i.test(provider)) throw new Error('Invalid provider identifier');
  return new NativeSession({
    workspace: path.resolve(options.workspace ?? process.cwd()),
    provider,
    model,
    executable: options.executable,
    argsPrefix: options.argsPrefix,
    env: options.env,
    profile: options.profile ?? 'sdk',
    sessionId: options.sessionId,
    artifactDir: options.artifactDir,
    maxHistory: options.maxHistory,
  });
}
