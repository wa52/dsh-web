import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PERMISSIONS = Object.freeze({ read: true, write: true, shell: false, network: false, gitCommit: false });
export function policyFor(role, requested = {}) {
  const policy = { ...DEFAULT_PERMISSIONS, ...requested };
  for (const key of Object.keys(DEFAULT_PERMISSIONS)) if (typeof policy[key] !== 'boolean') throw new Error(`Permission ${key} must be boolean`);
  if (role !== 'build' && role !== 'recovery') { policy.write = false; policy.shell = false; policy.network = false; }
  policy.gitCommit = false; // Controller owns all commits.
  return policy;
}

/** Reject symlink escapes, metadata writes and external paths before file tools execute. */
export function guardPath(root, candidate) {
  if (typeof candidate !== 'string' || !candidate) return 'File path required';
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'Path outside assigned worktree';
  if (relative.split(path.sep).some(segment => segment.toLowerCase() === '.git')) return 'Git metadata is Controller-owned';
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return 'Cannot resolve file parent';
    cursor = parent;
  }
  try {
    const real = fs.realpathSync(cursor);
    const relation = path.relative(fs.realpathSync(root), real);
    if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return 'Symlink escapes worktree';
    if (relation.split(path.sep).some(segment => segment.toLowerCase() === '.git')) return 'Git metadata is Controller-owned';
  } catch { return 'Cannot verify file boundary'; }
}

export function denyTool(root, permissions, name, args) {
  const reads = ['read', 'grep', 'find', 'ls', 'glob', 'list'];
  const writes = ['write', 'edit'];
  if (!reads.includes(name) && !writes.includes(name)) return 'Tool not permitted by Control Plane';
  if (reads.includes(name) && permissions.read === false) return 'Read permission denied';
  if (writes.includes(name) && !permissions.write) return 'Reviewer is read-only';
  if (args?.sandbox_permissions) return 'Worker cannot elevate sandbox permissions';
  if (name === 'glob' && typeof args?.pattern === 'string' && (path.isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes('..'))) return 'Glob escapes worktree';
  const explicitFile = args?.path ?? args?.file_path ?? args?.filePath;
  if ((writes.includes(name) || name === 'read') && (typeof explicitFile !== 'string' || !explicitFile)) return 'Known file target required';
  const file = explicitFile ?? '.';
  return guardPath(root, file);
}
