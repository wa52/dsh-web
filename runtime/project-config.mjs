import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { atomicJson, clone } from './store.mjs';

export const DEFAULT_HOST_AGENTS = {
  dsh: { transport: 'dsh', connectionId: 'dsh', provider: 'deepseek-official', model: 'deepseek-v4-flash', enabled: false, capabilities: ['code', 'debug', 'ui', 'review', 'reason'] },
  opencodeGo: { transport: 'opencode', connectionId: 'opencode-go', executable: 'opencode', enabled: true, capabilities: ['code', 'debug', 'ui', 'review', 'reason'] },
  pi: { transport: 'pi', connectionId: 'pi', executable: 'pi', enabled: false, capabilities: ['code', 'debug', 'ui', 'review', 'reason'] },
  codex: { transport: 'codex', connectionId: 'codex', executable: 'codex', enabled: false, capabilities: ['code', 'debug', 'ui', 'review', 'reason'] },
};

function assertAbsolute(label, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function assertStringArray(label, value, max = 100) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be a non-empty array of non-empty strings`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} items`);
}

export function validateProjectConfig(value, { allowCredentials = false } = {}) {
  if (!value || typeof value !== 'object') throw new Error('Project configuration must be an object');
  assertNonEmptyString('goal', value.goal);
  assertNonEmptyString('repository', value.repository);
  assertAbsolute('repository', value.repository);
  assertNonEmptyString('stateDir', value.stateDir);
  assertAbsolute('stateDir', value.stateDir);
  assertStringArray('successCriteria', value.successCriteria, 50);
  if (value.constraints !== undefined && (!Array.isArray(value.constraints) || value.constraints.some(item => typeof item !== 'string'))) throw new Error('constraints must be an array of strings');
  if (!Array.isArray(value.tests) || value.tests.length === 0) throw new Error('tests must be a non-empty array');
  for (const [index, test] of value.tests.entries()) {
    if (!test || typeof test !== 'object' || typeof test.executable !== 'string' || !test.executable.trim() || !Array.isArray(test.args) || test.args.some(arg => typeof arg !== 'string')) throw new Error(`tests[${index}] must have a non-empty executable and string args array`);
    if (test.executable.includes('&') || test.executable.includes('|') || test.executable.includes(';')) throw new Error(`tests[${index}] executable must not contain shell metacharacters`);
  }
  if (!allowCredentials) {
    for (const key of ['apiKey', 'apiKeyEnv', 'token', 'password', 'secret']) {
      if (value[key] !== undefined) throw new Error(`Credential field ${key} is not allowed in sanitized project configuration`);
    }
    if (value.agents) {
      for (const [alias, agent] of Object.entries(value.agents)) {
        if (!agent || typeof agent !== 'object' || Array.isArray(agent)) throw new Error(`Invalid agent selection for ${alias}`);
        for (const key of Object.keys(agent)) if (key !== 'enabled') throw new Error(`Credential/provider/paid or Host-owned field ${key} is not allowed in sanitized agent config for ${alias}`);
        if (agent.enabled !== undefined && typeof agent.enabled !== 'boolean') throw new Error(`Agent ${alias} enabled must be boolean`);
      }
    }
  }
  if (!allowCredentials && value.models !== undefined) throw new Error('models are Host-owned; browser setup cannot override provider/model routing');
  const maxActions = value.maxActions ?? 10;
  if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new Error('maxActions must be an integer 1..100');
  const agentTimeoutMs = value.agentTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs < 1000 || agentTimeoutMs > 3_600_000) throw new Error('agentTimeoutMs must be 1000..3600000');
  const testTimeoutMs = value.testTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(testTimeoutMs) || testTimeoutMs < 1000 || testTimeoutMs > 600_000) throw new Error('testTimeoutMs must be 1000..600000');
  const permissions = value.permissions ?? { read: true, write: true, shell: false, network: false, gitCommit: false };
  for (const key of Object.keys(permissions)) {
    if (typeof permissions[key] !== 'boolean') throw new Error(`Permission ${key} must be boolean`);
  }
  const protectedPaths = value.protectedPaths ?? [];
  if (!Array.isArray(protectedPaths) || protectedPaths.some(p => typeof p !== 'string' || path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('protectedPaths must be relative paths without parent traversal');
  const config = {
    goal: value.goal.trim(),
    repository: path.resolve(value.repository),
    stateDir: path.resolve(value.stateDir),
    constraints: (value.constraints ?? []).map(String),
    successCriteria: value.successCriteria.map(String),
    permissions,
    protectedPaths,
    tests: value.tests.map(test => ({ executable: String(test.executable), args: test.args.map(String) })),
    maxActions,
    agentTimeoutMs,
    testTimeoutMs,
    autoModelRouting: value.autoModelRouting !== false,
    decisionAgent: value.decisionAgent ?? 'auto',
    commercialLoop: value.commercialLoop?.enabled === false ? { enabled: false } : { enabled: true, worker: value.commercialLoop?.worker ?? 'auto', fetchReferences: value.commercialLoop?.fetchReferences !== false, maxAlignmentAttempts: 2, references: [] },
    agents: value.agents ?? {},
  };
  if (value.models) config.models = structuredClone(value.models);
  return config;
}

export async function loadProjectConfig(stateDir) {
  try {
    const file = path.join(path.resolve(stateDir), 'dsh-web-project.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return validateProjectConfig(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveProjectConfig(stateDir, config) {
  const sanitized = validateProjectConfig(config);
  const dir = path.resolve(stateDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'dsh-web-project.json');
  await atomicJson(file, sanitized);
  return file;
}

export function mergeAgentConfigs(projectAgents = {}, hostAgents = {}) {
  const merged = {};
  for (const [alias, host] of Object.entries(hostAgents)) {
    const project = projectAgents[alias] ?? {};
    if (host.enabled !== true || project.enabled === false) continue;
    // Browser owns selection only; authorized provider settings stay internal.
    merged[alias] = structuredClone(host);
  }
  return merged;
}

export function sanitizeProjectConfig(config) {
  const copy = clone(config);
  for (const key of ['apiKey', 'apiKeyEnv', 'token', 'password', 'secret']) delete copy[key];
  if (copy.agents) {
    copy.agents = Object.fromEntries(Object.entries(copy.agents).map(([alias, agent]) => [alias, { ...(typeof agent.enabled === 'boolean' ? { enabled: agent.enabled } : {}) }]));
  }
  delete copy.models;
  return copy;
}
