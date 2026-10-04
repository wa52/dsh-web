import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Version evidence for a Git root. Ignored build/cache files are outside its scope. */
export async function gitSnapshot(workspace) {
  const git = async args => (await exec('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
  const root = (await git(['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(root) !== await realpath(workspace)) throw new Error('workspace must be the Git root');
  let head = null;
  try { head = (await git(['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch (error) { if (error.code !== 128) throw error; }
  const names = [...new Set((await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort();
  const files = [];
  for (const name of names) {
    const target = path.resolve(workspace, name);
    if (path.relative(workspace, target).startsWith('..')) throw new Error('Unsafe Git path');
    try {
      const info = await lstat(target);
      if (info.isDirectory()) throw new Error(`Submodules require a custom snapshot adapter: ${name}`);
      const symlink = info.isSymbolicLink();
      files.push({ name, type: symlink ? 'symlink' : 'file', mode: info.mode, hash: sha(symlink ? await readlink(target) : await readFile(target)) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files.push({ name, type: 'deleted' });
    }
  }
  return { head, indexHash: sha(await git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'])), files };
}
