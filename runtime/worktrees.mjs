import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gitSnapshot } from '../plugins/autonomous-control-loop/git-snapshot.js';
const exec = promisify(execFile);
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class WorktreeManager {
  constructor(repository, directory, projectId) { Object.assign(this, { repository, directory, projectId }); }
  async git(cwd, args) { return (await exec('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })).stdout.trim(); }
  async validate() {
    const root = await this.git(this.repository, ['rev-parse', '--show-toplevel']);
    if (await realpath(root) !== await realpath(this.repository)) throw new Error('Repository must be its Git root');
    await this.git(this.repository, ['rev-parse', '--verify', 'HEAD']);
  }
  async create(id, role, base) {
    if (!/^[a-zA-Z0-9-]+$/.test(id) || !/^[a-z-]+$/.test(role)) throw new Error('Unsafe worktree identity');
    await mkdir(this.directory, { recursive: true });
    const directory = path.join(this.directory, `${role}-${id}`);
    const branch = `dsh/${this.projectId}/${role}-${id}`;
    await this.git(this.repository, ['worktree', 'add', '-b', branch, directory, base]);
    return { directory, branch, base };
  }
  async snapshot(directory) { const evidence = await gitSnapshot(directory); return { hash: hash(evidence), evidence }; }
  async remove(tree) {
    const relation = path.relative(path.resolve(this.directory), path.resolve(tree.directory));
    if (!relation || path.isAbsolute(relation) || relation === '..' || relation.startsWith(`..${path.sep}`) || !tree.branch.startsWith(`dsh/${this.projectId}/`)) throw new Error('Unsafe temporary worktree cleanup');
    await this.git(this.repository, ['worktree', 'remove', '--force', tree.directory]);
    if (/\/(observe|review)-/.test(tree.branch)) await this.git(this.repository, ['branch', '-D', tree.branch]);
  }
  async commit(tree, message) {
    await this.git(tree.directory, ['add', '--all']);
    const changes = await this.git(tree.directory, ['diff', '--cached', '--name-only']);
    if (!changes) return await this.git(tree.directory, ['rev-parse', 'HEAD']);
    await this.git(tree.directory, ['-c', 'user.name=DSH Controller', '-c', 'user.email=dsh-controller@localhost', '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', 'commit', '-m', message]);
    return await this.git(tree.directory, ['rev-parse', 'HEAD']);
  }
  async diff(tree) { return await this.git(tree.directory, ['diff', '--no-ext-diff', '--no-textconv', `${tree.base}..HEAD`]); }
  async protectedHashes(directory, protectedPaths) {
    const results = {};
    for (const relative of protectedPaths) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe protected path');
      try { results[relative] = hash((await readFile(path.join(directory, relative))).toString('base64')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; results[relative] = null; }
    }
    return results;
  }
}
