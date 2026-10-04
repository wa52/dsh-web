import { mkdir, open, readFile, rename, unlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { processFingerprint } from './process.mjs';

export const clone = value => structuredClone(value);
export async function atomicJson(file, value) {
  const serialized = JSON.stringify(value, null, 2);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export class WorldStore {
  constructor(directory) { this.directory = path.resolve(directory); this.file = path.join(this.directory, 'world.json'); }
  async load() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      if (state.version !== 2 || !Array.isArray(state.actions) || !Array.isArray(state.decisions)) throw new Error('Invalid V1 world state');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(state) { state.revision++; state.updatedAt = new Date().toISOString(); await atomicJson(this.file, state); }
  async acquire() {
    await mkdir(this.directory, { recursive: true });
    const recoveryFile = path.join(this.directory, 'recovery.lock');
    const checkRecovery = async () => { try { await readFile(recoveryFile); throw new Error('Recovery is in progress'); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    await checkRecovery();
    const file = path.join(this.directory, 'runtime.lock');
    const handle = await open(file, 'wx').catch(error => { if (error.code === 'EEXIST') throw new Error('Recovery required: runtime.lock exists; verify and stop interrupted Workers before restarting'); throw error; });
    try { await checkRecovery(); }
    catch (error) { await handle.close(); await unlink(file); throw error; }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, fingerprint: await processFingerprint(process.pid), token: randomUUID(), at: new Date().toISOString() })); }
    catch (error) { await handle.close(); await unlink(file); throw error; }
    return async () => { await handle.close(); await unlink(file); };
  }
  async assertOutside(repository) {
    await mkdir(this.directory, { recursive: true });
    const relative = path.relative(await realpath(repository), await realpath(this.directory));
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('Runtime state/worktrees must be outside the target repository');
  }
}
