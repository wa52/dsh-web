import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { guardPath } from './permissions.mjs';
import { redact } from './process.mjs';

// Host-owned minimum: model risk can escalate, never downgrade these paths.
export function changedPathRisk(files, diff = '') {
  const sensitive = files.filter(file => /(?:^|\/)(?:auth|iam|permissions?|payments?|billing|migrations?|schema)(?:\/|[._-]|$)|(?:^|\/)(?:login|session|token|database)[._-]/i.test(file.replaceAll('\\', '/')));
  const sensitiveContent = diff.split('\n').some(line => /^[+-](?![+-])/.test(line) && /\b(?:checkoutComplete|paymentInitialize|paymentCreate|tokenCreate|tokenRefresh|authenticate|authorization|password|access_token)\b/i.test(line));
  return { risk: sensitive.length || sensitiveContent ? 'high' : 'normal', sensitivePaths: sensitive, sensitiveContent };
}

export async function sourceObservation(directory, files, budget = 120000) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('sourceBudgetBytes must be a positive integer');
  const eligible = files.filter(file => file.type === 'file' && /\.(?:[cm]?[jt]sx?|py|cs|java|html|css|md|json)$/.test(file.name) && !/(?:^|\/)(?:auth\.json|.*(?:credentials|secret|\.local\.|lock).*)$/i.test(file.name) && !guardPath(directory, file.name));
  const groups = new Map();
  for (const file of eligible) { const key = file.name.split('/')[0]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(file); }
  const ordered = [];
  while ([...groups.values()].some(group => group.length)) for (const group of groups.values()) if (group.length) ordered.push(group.shift());
  const sources = {}, included = [], omitted = [];
  let remaining = budget;
  const limit = Math.max(256, Math.min(32000, Math.floor(budget / Math.max(1, eligible.length))));
  for (const file of ordered) {
    if (!remaining) { omitted.push(file.name); continue; }
    const content = await readFile(path.join(directory, file.name));
    if (content.includes(0)) { omitted.push(file.name); continue; }
    const cap = Math.min(remaining, limit);
    let excerpt = content.subarray(0, cap).toString('utf8');
    // A byte cut may split UTF-8. Drop the partial final code point.
    if (Buffer.byteLength(excerpt) > cap) excerpt = excerpt.slice(0, -1);
    excerpt = redact(excerpt);
    const used = Buffer.byteLength(excerpt);
    if (used > remaining) { omitted.push(file.name); continue; }
    sources[file.name] = excerpt; remaining -= used;
    included.push({ path: file.name, includedBytes: used, totalBytes: content.length, truncated: content.length > cap });
  }
  return { sources, sourceCoverage: { budgetBytes: budget, usedBytes: budget - remaining, eligibleFiles: eligible.length, included, omitted, complete: omitted.length === 0 && included.every(file => !file.truncated) } };
}

export function testSummary(reports) {
  return reports.map(({ passed, output = '', ...metadata }) => ({ ...metadata, passed, output: output.slice(-8000), outputTruncated: output.length > 8000 }));
}
