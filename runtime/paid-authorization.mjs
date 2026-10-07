import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './store.mjs';

const capabilities = new WeakMap();
const ledgerTransactions = new Map();
const projectKey = value => createHash('sha256').update(path.resolve(value)).digest('hex');
const ledgerPath = stateDir => path.join(path.resolve(stateDir), 'paid-api', 'ledger.json');
const lockPath = stateDir => path.join(path.resolve(stateDir), 'paid-api', 'ledger.lock');

function cleanEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Paid API endpoint must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Paid API endpoint must be HTTP(S), without credentials, query, or fragment');
  return url.toString().replace(/\/$/, '');
}

async function acquire(stateDir) {
  const directory = path.dirname(lockPath(stateDir));
  await mkdir(directory, { recursive: true });
  const lock = lockPath(stateDir);
  const owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    let created = false;
    try {
      await mkdir(lock);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
      continue;
    }
    if (!created) continue;
    // A crash while publishing owner.json intentionally leaves an incomplete
    // lock. Never infer that a lock is safe to steal from PID, age, inode or
    // token observations: another process may have replaced it after a check.
    try { await atomicJson(path.join(lock, 'owner.json'), owner); }
    catch (error) {
      throw new Error(`Could not initialize paid API ledger lock at ${lock}; it was left in place and requires operator recovery after all controllers stop: ${error.message}`, { cause: error });
    }
    return async () => {
      try {
        // ABA safety: only delete the lock directory if it still contains our
        // own owner token. A concurrent recovery or replacement owner will have
        // a different token, so this release must not delete their live lock.
        const held = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
        if (held.token === owner.token) await rm(lock, { recursive: true, force: true });
      } catch (error) {
        // ENOENT means the lock was already removed (e.g. operator recovery) or
        // never had an owner file (incomplete lock). Either way we must not
        // recreate or auto-recover it here; fail closed.
        if (error.code !== 'ENOENT') throw error;
      }
    };
  }
  throw new Error(`Timed out waiting for paid API authorization ledger lock at ${lock}. It may be stale or incomplete; stop every controller sharing this state directory, then follow the documented operator recovery procedure. The lock was not removed.`);
}

async function updateLedger(stateDir, change) {
  // Register before any filesystem await: an already-requested revocation must
  // not be overtaken by a reservation in this process. The physical lock still
  // serializes every transaction with other processes, without stealing locks.
  const key = lockPath(stateDir);
  const previous = ledgerTransactions.get(key);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  ledgerTransactions.set(key, pending);
  try {
    await previous;
    return await updateLockedLedger(stateDir, change);
  } finally {
    finish(); // A failed transaction must not poison subsequent transactions.
    if (ledgerTransactions.get(key) === pending) ledgerTransactions.delete(key);
  }
}

async function updateLockedLedger(stateDir, change) {
  const release = await acquire(stateDir);
  try {
    const file = ledgerPath(stateDir);
    let ledger;
    try { ledger = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { version: 1, grants: [], reservations: [] }; }
    if (ledger.version !== 1 || !Array.isArray(ledger.grants) || !Array.isArray(ledger.reservations)) throw new Error('Paid API authorization ledger is invalid');
    const result = await change(ledger);
    await atomicJson(file, ledger);
    return result;
  } finally { await release(); }
}

/** Host-operator API. Call only after an explicit human approval ceremony. */
export async function createPaidApiGrant(stateDir, input) {
  if (!input || typeof input.connectionId !== 'string' || !input.connectionId.trim()) throw new Error('Grant connectionId is required');
  if (!Array.isArray(input.models) || !input.models.length || input.models.some(model => typeof model !== 'string' || !model.trim()) || new Set(input.models).size !== input.models.length) throw new Error('Grant requires a unique, non-empty exact model allowlist');
  if (!Number.isSafeInteger(input.maxWorkerRuns) || input.maxWorkerRuns < 1) throw new Error('maxWorkerRuns must be a positive integer');
  const expiresAt = new Date(input.expiresAt).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('Grant expiry must be in the future');
  const endpoint = cleanEndpoint(input.endpoint);
  const project = path.resolve(input.project);
  const state = path.resolve(stateDir);
  const relation = path.relative(project, state);
  if (!relation || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`))) throw new Error('Paid API authorization ledger must be outside the project workspace');
  const grant = {
    id: randomUUID(), connectionId: input.connectionId, models: [...input.models], endpoint,
    project, projectKey: projectKey(project), expiresAt,
    maxWorkerRuns: input.maxWorkerRuns, consumedWorkerRuns: 0, active: true,
    approvedAt: new Date().toISOString(), approvalReason: 'explicit Host operator approval',
  };
  await updateLedger(stateDir, ledger => { ledger.grants.push(grant); });
  return { id: grant.id, connectionId: grant.connectionId, models: grant.models, endpoint: grant.endpoint, expiresAt: grant.expiresAt, maxWorkerRuns: grant.maxWorkerRuns };
}

export async function revokePaidApiGrant(stateDir, id) {
  return updateLedger(stateDir, ledger => {
    const grant = ledger.grants.find(row => row.id === id);
    if (!grant) throw new Error('Unknown paid API grant');
    grant.active = false;
    grant.revokedAt = new Date().toISOString();
    grant.revocationReason = 'Host operator revoked grant';
    return { id: grant.id, active: false, consumedWorkerRuns: grant.consumedWorkerRuns };
  });
}

export async function eligiblePaidConnections({ stateDir, project, requirements }) {
  const key = projectKey(project);
  return updateLedger(stateDir, ledger => {
    const eligible = new Set();
    for (const requirement of requirements) {
      if (ledger.grants.some(grant => grant.active && grant.connectionId === requirement.connectionId
        && grant.models.includes(requirement.modelId) && grant.endpoint === cleanEndpoint(requirement.endpoint)
        && grant.projectKey === key && Date.parse(grant.expiresAt) > Date.now()
        && grant.consumedWorkerRuns < grant.maxWorkerRuns)) eligible.add(`${requirement.connectionId}\0${requirement.modelId}\0${cleanEndpoint(requirement.endpoint)}`);
    }
    return [...eligible];
  });
}

/** Atomically reserve one non-refundable Worker run and mint an unforgeable in-process capability. */
export async function reservePaidApiRun({ stateDir, connectionId, modelId, endpoint, project, runId }) {
  const normalizedEndpoint = cleanEndpoint(endpoint);
  const reservation = await updateLedger(stateDir, ledger => {
    const key = projectKey(project);
    const grant = ledger.grants.find(row => row.active && row.connectionId === connectionId && row.models.includes(modelId)
      && row.endpoint === normalizedEndpoint && row.projectKey === key && Date.parse(row.expiresAt) > Date.now()
      && row.consumedWorkerRuns < row.maxWorkerRuns);
    if (!grant) {
      const error = new Error(`Paid API authorization needed for connection ${connectionId}, model ${modelId}`);
      error.failureKind = 'authorization-needed';
      throw error;
    }
    grant.consumedWorkerRuns++;
    const row = { id: randomUUID(), grantId: grant.id, connectionId, modelId, endpoint: normalizedEndpoint, projectKey: key, runId, at: new Date().toISOString(), reason: 'reserved before Worker preparation; reservation is non-refundable' };
    ledger.reservations.push(row);
    return row;
  });
  const token = Object.freeze(Object.create(null));
  capabilities.set(token, reservation);
  return token;
}

function validateReservation(token, { connectionId, modelId, endpoint, project, runId } = {}) {
  const reservation = token && capabilities.get(token);
  const sameProject = typeof project === 'string' && project.length > 0 && reservation?.projectKey === projectKey(project);
  if (!reservation || reservation.connectionId !== connectionId || reservation.modelId !== modelId
    || reservation.endpoint !== cleanEndpoint(endpoint) || !sameProject
    || reservation.runId !== runId) {
    const error = new Error(`Paid API authorization needed for connection ${connectionId}, model ${modelId}`);
    error.failureKind = 'authorization-needed';
    throw error;
  }
  return reservation;
}

export function assertPaidApiRunAuthorization(token, scope) {
  const reservation = validateReservation(token, scope);
  capabilities.delete(token);
  return reservation;
}

export function hasPaidApiRunAuthorization(token, scope) {
  try { validateReservation(token, scope); return true; } catch { return false; }
}
