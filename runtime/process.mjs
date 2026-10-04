import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);

export const redact = text => String(text)
  .replace(/(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]{16,})/g, '[REDACTED]')
  .replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');

export function parseObject(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length > 1) throw new Error('Ambiguous JSON response: multiple objects');
  const clean = blocks.length === 1 ? blocks[0][1].trim() : text.trim().replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Agent must return one JSON object');
  return value;
}

/** Stop the entire process group/tree, not only its launcher. */
export async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
    catch (error) { if (child.exitCode === null && child.signalCode === null && await processFingerprint(child.pid)) throw error; }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export async function processFingerprint(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid PID');
  try {
    if (process.platform === 'win32') {
      const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const output = (await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | ForEach-Object { $_.CreationDate.ToUniversalTime().Ticks.ToString() + ':' + $_.ExecutablePath }`], { windowsHide: true })).stdout.trim();
      return output ? createHash('sha256').update(output).digest('hex') : null;
    }
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

export async function stopRecordedRun(record) {
  const fingerprint = await processFingerprint(record.pid);
  if (!fingerprint) return;
  if (!record.fingerprint || fingerprint !== record.fingerprint) throw new Error(`Cannot safely identify recorded process ${record.pid}`);
  await killTree({ pid: record.pid, exitCode: null, signalCode: null });
  if (await processFingerprint(record.pid) === fingerprint) throw new Error('Recorded Worker is still alive');
}

/** Reconcile a crash after spawn but before the PID publication checkpoint. */
export async function findLaunchProcesses(token) {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid launch journal token');
  let pids;
  if (process.platform === 'win32') {
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const output = (await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${token}') -and $_.ProcessId -ne ${process.pid} } | Select-Object -ExpandProperty ProcessId`], { windowsHide: true })).stdout;
    pids = output.trim().split(/\s+/).map(Number).filter(pid => pid > 0 && pid !== process.pid);
  } else {
    pids = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const command = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
      if (command.includes(token)) pids.push(Number(name));
    }
  }
  const records = [];
  for (const pid of pids) { const fingerprint = await processFingerprint(pid); if (fingerprint) records.push({ pid, fingerprint }); }
  return records;
}

function launch(executable, args, options, launchToken) {
  if (process.platform === 'win32' && !path.isAbsolute(executable) && !executable.includes('/')) {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      const match = ['.exe', '.ps1', ''].map(suffix => path.join(directory, executable + suffix)).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (match) { executable = match; break; }
    }
  }
  if (process.platform === 'win32' && executable.toLowerCase().endsWith('.ps1')) {
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args];
    executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  }
  if (/\.(cmd|bat)$/i.test(executable)) throw new Error('Use a native executable, .ps1, or Node entry point; shell command strings are prohibited');
  if (process.platform === 'win32') {
    const helper = fileURLToPath(new URL('./windows-job.ps1', import.meta.url));
    const token = launchToken ?? args.map(String).join(' ').match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0] ?? randomUUID();
    const spec = Buffer.from(JSON.stringify({ executable, args })).toString('base64');
    return spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', helper, '-Spec', spec, '-LaunchToken', token], options);
  }
  return spawn(executable, args, options);
}

/** Common lifecycle implementation for all CLI/RPC adapters. */
export class ProcessAdapter {
  constructor(metadata, prepare) { Object.assign(this, metadata); this.prepare = prepare; this.runs = new Map(); this.availability = 'unknown'; }
  async start(task) {
    if (task.signal?.aborted) throw new Error('Run canceled before start');
    const launchSpec = await this.prepare(task);
    // Codex output file, Pi guard file, DSH patch file and OpenCode session title
    // contain the journal token even though RPC/stdin also carries the prompt.
    if (task.runKey && !(launchSpec.args ?? []).some(arg => String(arg).includes(task.runKey))) throw new Error('Native process argv lacks the durable launch token');
    const id = randomUUID();
    const logPath = path.join(task.artifactDir, `${this.id}-${id}.log`);
    await mkdir(task.artifactDir, { recursive: true });
    const child = launch(launchSpec.executable, launchSpec.args, { cwd: task.workspace, env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...launchSpec.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }, task.runKey);
    const info = { id, worker: this.id, pid: child.pid, role: task.role, permissions: task.permissions, status: 'running', startedAt: new Date().toISOString(), workspace: task.workspace, logPath };
    this.runs.set(id, info);
    let settle, reject, pending = '', output = '', terminal = false, logged = Promise.resolve(), stopped = false;
    const result = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    // A result may settle before the Controller attaches its consumer.
    result.catch(() => {});
    const closed = new Promise(resolve => child.once('close', resolve));
    child.once('close', () => {
      clearTimeout(timer);
      task.signal?.removeEventListener('abort', abort);
    });
    const send = value => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
    const fail = error => {
      if (terminal) return;
      terminal = true; info.status = 'failed'; info.error = redact(error.message); reject(error);
    };
    const complete = value => {
      if (terminal) return;
      terminal = true; info.status = 'completed'; info.finishedAt = new Date().toISOString(); this.availability = 'online';
      settle({ ...value, runId: id, worker: this.id, logPath });
    };
    const log = text => {
      const safe = redact(text);
      logged = logged.then(() => appendFile(logPath, safe)).catch(fail);
      task.onEvent?.({ type: 'run-log', runId: id, worker: this.id, text: safe.slice(0, 2000) });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      log(chunk); output += chunk;
      if (output.length > 8 * 1024 * 1024) { fail(new Error('Agent output exceeded 8 MiB limit')); void killTree(child).catch(fail); return; }
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        try { launchSpec.onFrame?.(JSON.parse(line), { send, complete, fail }); }
        catch (error) { if (launchSpec.strictFrames) fail(error); }
      }
    });
    child.stderr.on('data', log);
    child.on('error', fail);
    child.stdin.on('error', error => { if (!stopped && error.code !== 'EPIPE') fail(error); });
    child.on('close', async code => {
      info.exitCode = code;
      try {
        await logged;
        if (!terminal) {
          if (code !== 0) throw new Error(`${this.id} exited ${code}; see ${logPath}`);
          complete(await launchSpec.finish(output));
        }
      } catch (error) { fail(error); }
    });
    let disposing;
    const dispose = () => disposing ??= (async () => {
      stopped = true;
      if (!terminal) fail(new Error('Run interrupted by Controller'));
      await killTree(child);
      await closed;
      await logged;
      task.signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      info.stoppedAt = new Date().toISOString();
      task.onEvent?.({ type: 'run-stopped', ...info });
    })();
    const abort = () => { void dispose().catch(fail); };
    task.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { fail(new Error('Agent run budget exceeded')); void dispose().catch(fail); }, task.timeoutMs ?? 300_000);
    try {
      if (!child.pid) throw new Error(`Cannot spawn ${launchSpec.executable}; use an absolute native/.ps1 executable or Node argsPrefix`);
      info.fingerprint = await processFingerprint(child.pid);
    }
    catch (error) { await dispose(); throw error; }
    task.onEvent?.({ type: 'run-started', ...info });
    launchSpec.begin?.({ send });
    if (launchSpec.stdin !== undefined) child.stdin.end(launchSpec.stdin);
    if (task.signal?.aborted) abort();
    return { id, pid: child.pid, result, dispose, send: message => {
      if (stopped || terminal) throw new Error('Run no longer accepts messages');
      if (!launchSpec.send) throw new Error(`${this.id} does not support continuation`);
      launchSpec.send(message, { send });
    } };
  }
  send(id, message) { const run = this.handles?.get(id); if (!run) throw new Error('Unknown live run'); return run.send(message); }
  status(id) { return this.runs.get(id)?.status ?? 'unknown'; }
  describe() { return { id: this.id, provider: this.provider, capabilities: this.capabilities, trust: this.trust, cost: this.cost, roles: this.roles, availability: this.availability, runs: [...this.runs.values()] }; }
}

export async function runCommand(command, workspace, { timeoutMs = 60_000, artifactDir, name = 'test', signal } = {}) {
  if (!command?.executable || !Array.isArray(command.args)) throw new Error('Test command must be executable + argv');
  const adapter = new ProcessAdapter({ id: name, roles: ['test'] }, async () => ({ ...command, finish: output => ({ output: redact(output) }), stdin: '' }));
  const handle = await adapter.start({ workspace, artifactDir, timeoutMs, signal });
  try { return { passed: true, ...await handle.result }; }
  catch (error) {
    const logPath = adapter.runs.get(handle.id).logPath;
    return { passed: false, error: redact(error.message), logPath, output: redact(await readFile(logPath, 'utf8').catch(() => '')).slice(-120_000) };
  }
  finally { await handle.dispose(); }
}
