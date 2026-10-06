import { spawn, execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicJson, WorldStore } from './store.mjs';
import { processFingerprint, redact } from './process.mjs';
import { recoverInterruptedProject } from './recovery.mjs';

const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FINAL_REPORT_BYTES = 8 * 1024 * 1024;
const exec = promisify(execFile);

function safeDiagnostic(value, limit = 4000) {
  return redact(String(value ?? ''))
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|launch[_-]?token|password|passwd|secret|client[_-]?secret)\s*[=:]\s*["']?)[^\s,;}'"]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|launch[_-]?token|password|passwd|secret|client[_-]?secret)["']?\s*:\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, limit);
}

class OutputTail {
  constructor(limit) { this.limit = limit; this.buffer = Buffer.alloc(0); this.totalBytes = 0; }
  push(chunk) {
    this.totalBytes += chunk.length;
    // Redact after retaining an overlap so a credential split across stream
    // chunks is not emitted in fragments. The retained memory is still fixed.
    this.buffer = Buffer.concat([this.buffer, chunk]).subarray(-(this.limit + 8192));
  }
  value() {
    const safe = Buffer.from(safeDiagnostic(this.buffer.toString('utf8'), this.limit * 2 + 16384));
    const tail = safe.subarray(-this.limit);
    return {
      text: tail.toString('utf8'),
      capturedBytes: tail.length,
      totalBytes: this.totalBytes,
      truncated: this.totalBytes > this.limit || safe.length > this.limit,
    };
  }
}

function safeArgv(args) {
  const safe = [];
  let redactNext = false;
  for (const value of args) {
    const arg = String(value);
    if (redactNext) { safe.push('[REDACTED]'); redactNext = false; continue; }
    if (/^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|launch[-_]?token|token|password|passwd|secret|client[-_]?secret|authorization)$/i.test(arg)) {
      safe.push(arg); redactNext = true; continue;
    }
    safe.push(safeDiagnostic(arg));
  }
  return safe;
}

async function durablePhase(stateDir) {
  try {
    const state = await new WorldStore(stateDir).load();
    const eventPhase = state?.events?.at(-1)?.phase;
    return typeof eventPhase === 'string' ? eventPhase : typeof state?.phase === 'string' ? state.phase : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

async function inspectStaleRuntime(stateDir) {
  let state;
  let inspectionError = null;
  try { state = await new WorldStore(stateDir).load(); }
  catch (error) { inspectionError = safeDiagnostic(error.message); }
  let lockPresent = false;
  try { await stat(path.join(stateDir, 'runtime.lock')); lockPresent = true; }
  catch (error) { if (error.code !== 'ENOENT') { lockPresent = true; inspectionError ??= safeDiagnostic(error.message); } }
  return { needed: Boolean(inspectionError || lockPresent || state?.status === 'running'), lockPresent, stateStatus: state?.status ?? null, inspectionError };
}

async function readFinalReport(file) {
  if (!file) return { valid: false, status: null, error: 'No finalReportPath configured' };
  try {
    const fileStat = await stat(file, { bigint: true });
    if (fileStat.size > BigInt(MAX_FINAL_REPORT_BYTES)) return { valid: false, status: null, error: 'Final report exceeds 8 MiB limit' };
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.status !== 'string' || !value.status.trim()) {
      return { valid: false, status: null, error: 'Final report must be a JSON object with a non-empty status' };
    }
    return { valid: true, status: value.status, report: value };
  } catch (error) {
    if (error.code === 'ENOENT') return { valid: false, status: null, error: 'Final report is missing' };
    return { valid: false, status: null, error: `Final report could not be read: ${safeDiagnostic(error.message)}` };
  }
}

async function reportIdentity(file) {
  if (!file) return null;
  try {
    const fileStat = await stat(file, { bigint: true });
    if (fileStat.size > BigInt(MAX_FINAL_REPORT_BYTES)) throw new Error('Final report exceeds 8 MiB limit');
    const content = await readFile(file);
    return { size: fileStat.size.toString(), inode: fileStat.ino.toString(), modified: fileStat.mtimeNs.toString(), digest: createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function verifyControllerDescendants(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    throw new Error('Controller process group still has descendants; refusing recovery');
  }
  if (!process.env.SystemRoot) throw new Error('SystemRoot is unavailable; cannot verify controller descendants');
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const descendants = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) {
      const childPid = Number(row.ProcessId);
      if (descendants.has(Number(row.ParentProcessId)) && Number.isSafeInteger(childPid) && childPid > 0 && !descendants.has(childPid)) {
        descendants.add(childPid);
        changed = true;
      }
    }
  }
  descendants.delete(pid);
  if (descendants.size) throw new Error('Controller descendants remain unconfirmed; refusing recovery');
}

function validateOptions(options) {
  if (!options || typeof options.executable !== 'string' || !options.executable.trim() || !Array.isArray(options.args) || options.args.some(arg => typeof arg !== 'string')) {
    throw new Error('Supervisor requires an executable and an argv string array');
  }
  if (/\.(?:cmd|bat)$/i.test(options.executable)) throw new Error('Use a native executable; shell command files are prohibited');
  if (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)) throw new Error('Supervisor cwd must be an absolute path');
  if (typeof options.stateDir !== 'string' || !path.isAbsolute(options.stateDir)) throw new Error('Supervisor stateDir must be an absolute path');
  if (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Array.isArray(options.env))) throw new Error('Supervisor env overrides must be an object');
  const limit = options.outputLimitBytes ?? DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > MAX_OUTPUT_BYTES) throw new Error(`outputLimitBytes must be 1024..${MAX_OUTPUT_BYTES}`);
  const resultPath = path.resolve(options.resultPath ?? path.join(options.stateDir, 'supervisor-result.json'));
  const finalReportPath = options.finalReportPath ? path.resolve(options.finalReportPath) : null;
  const sameFile = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (finalReportPath && sameFile(finalReportPath, resultPath)) throw new Error('Supervisor resultPath must not replace the final report');
  return { ...options, stateDir: path.resolve(options.stateDir), resultPath, finalReportPath, outputLimitBytes: limit };
}

/**
 * Run one controller process and report its real process outcome from outside it.
 * A valid controller report is read-only input; only the configured supervisor
 * result path is written by this function. Recovery is attempted only when no
 * fresh valid final report exists and the launched process emitted close.
 */
export async function runSupervisedController(rawOptions) {
  const options = validateOptions(rawOptions);
  const stdout = new OutputTail(options.outputLimitBytes);
  const stderr = new OutputTail(options.outputLimitBytes);
  const startedAt = new Date().toISOString();
  const initialReportIdentity = await reportIdentity(options.finalReportPath);
  let phase = await durablePhase(options.stateDir);
  let phaseTimer;
  let phaseGeneration = 0;
  let fingerprint = null;
  let fingerprintError = null;
  let spawnFailure = null;
  let exitCode = null;
  let signal = null;
  let closed = false;
  let parentSignal = null;
  let child;
  let closePromise;

  try {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: { ...childEnv, ...(options.env ?? {}) },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    spawnFailure = safeDiagnostic(error.message);
  }

  const signalHandlers = new Map();
  if (child) {
    closePromise = new Promise(resolve => child.once('close', (code, childSignal) => {
      if (exitCode === null) exitCode = code;
      if (signal === null) signal = childSignal;
      closed = true;
      resolve();
    }));
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stderr?.on('data', chunk => stderr.push(chunk));
    child.once('error', error => { if (!child.pid) spawnFailure = safeDiagnostic(error.message); });
    child.once('exit', (code, childSignal) => { exitCode = code; signal = childSignal; });
    phaseTimer = setInterval(() => {
      const generation = ++phaseGeneration;
      void durablePhase(options.stateDir).then(value => { if (value && generation === phaseGeneration) phase = value; });
    }, 100);
    phaseTimer.unref?.();

    for (const name of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        parentSignal = name;
        if (child && child.exitCode === null && child.signalCode === null) child.kill(name);
      };
      signalHandlers.set(name, handler);
      process.on(name, handler);
    }

    if (child.pid) {
      try { fingerprint = await processFingerprint(child.pid); }
      catch (error) { fingerprintError = safeDiagnostic(error.message); }
    }
  }

  if (closePromise) await closePromise;
  clearInterval(phaseTimer);
  phaseGeneration++;
  for (const [name, handler] of signalHandlers) process.off(name, handler);
  phase = (await durablePhase(options.stateDir)) ?? phase;

  const finalReport = await readFinalReport(options.finalReportPath);
  let finalReportIdentity = null;
  let finalReportIdentityError = null;
  try { finalReportIdentity = await reportIdentity(options.finalReportPath); }
  catch (error) { finalReportIdentityError = safeDiagnostic(error.message); }
  const finalReportCurrentRun = finalReport.valid && !finalReportIdentityError && (initialReportIdentity === null
    ? finalReportIdentity !== null
    : finalReportIdentity !== null && ['size', 'inode', 'modified', 'digest'].some(key => initialReportIdentity[key] !== finalReportIdentity[key]));
  let descendantVerificationError = null;
  if (closed && child?.pid) {
    try { await verifyControllerDescendants(child.pid); }
    catch (error) { descendantVerificationError = safeDiagnostic(error.message); }
  }
  const staleState = await inspectStaleRuntime(options.stateDir);
  const runtimeState = { ...staleState, needed: staleState.needed || Boolean(descendantVerificationError), descendantVerificationError };
  let recovery = { attempted: false, status: 'not-needed' };
  if ((!(finalReport.valid && finalReportCurrentRun) || runtimeState.needed) && closed && child?.pid) {
    recovery = { attempted: true, status: 'blocked' };
    try {
      await recoverInterruptedProject({ stateDir: options.stateDir }, {
        controllerTermination: { confirmed: true, closed, pid: child.pid, fingerprint: fingerprint ?? null },
        verifyControllerDescendants,
      });
      recovery.status = 'reconciled';
    } catch (error) {
      recovery.error = safeDiagnostic(error.message);
    }
  }

  const normalizedStatus = finalReport.status?.trim().toUpperCase();
  const finalReportSuccess = ['PASS', 'SUCCESS', 'COMPLETE'].includes(normalizedStatus);
  const succeeded = exitCode === 0 && signal === null && !spawnFailure && finalReport.valid && finalReportCurrentRun && finalReportSuccess && !runtimeState.needed;
  // A final report declaring anything other than a success status is the
  // failure itself, current-run or inherited; a zero exit never upgrades it.
  // Only an unchanged success-class report is 'stale-final-report'.
  const failureType = succeeded ? null
    : spawnFailure ? 'spawn-failure'
      : signal ? 'controller-signal'
        : exitCode !== 0 ? 'controller-exit'
          : !finalReport.valid ? 'missing-or-invalid-final-report'
              : !finalReportSuccess ? 'final-report-failure'
              : !finalReportCurrentRun ? 'stale-final-report'
                : runtimeState.descendantVerificationError ? 'unconfirmed-descendants'
                  : runtimeState.needed ? 'stale-runtime-state'
                  : 'final-report-failure';
  const finishedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    status: succeeded ? 'PASS' : 'FAIL',
    startedAt,
    finishedAt,
    controller: { executable: safeDiagnostic(options.executable), args: safeArgv(options.args), cwd: options.cwd, pid: child?.pid ?? null, fingerprint, fingerprintError, exitCode, signal, parentSignal, spawnFailure, closeEventSeen: closed, confirmedClosed: closed && Boolean(child?.pid) },
    lastDurablePhase: phase,
    finalReport: { path: options.finalReportPath, valid: finalReport.valid, currentRun: finalReportCurrentRun, status: finalReport.status, error: finalReport.error ?? finalReportIdentityError ?? null },
    runtimeState,
    failureType,
    stdout: stdout.value(),
    stderr: stderr.value(),
    recovery,
  };
  if (!(finalReport.valid && finalReportCurrentRun) || runtimeState.needed) result.failureObservation = {
    status: 'FAIL',
    reason: failureType,
    detail: spawnFailure ?? (signal ? `Controller terminated by ${signal}`
      : exitCode !== 0 ? `Controller exited with code ${exitCode}`
        : runtimeState.descendantVerificationError ? runtimeState.descendantVerificationError
          : runtimeState.needed ? 'Controller terminated while runtime state or controller lock remained active'
          : finalReport.valid && !finalReportSuccess ? `Final report declares status ${finalReport.status}`
            : finalReport.error ?? 'Final report is missing or stale'),
    lastDurablePhase: phase,
  };
  await atomicJson(options.resultPath, result);
  return result;
}
