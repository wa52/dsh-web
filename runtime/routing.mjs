// Host-supplied automatic per-action model routing.
//
// The catalog is entirely Host configuration: there is no built-in vendor list,
// no hardcoded model name and no asserted quota amount here. A model called
// "pro" and a model called "flash" are indistinguishable to this module except
// through their metadata, so prohibition is expressed as `prohibited: true` and
// eligibility as `eligible: false` rather than a brittle name match.

export const MODEL_TIERS = Object.freeze(['routine', 'deep', 'security']);

// A routine requirement is satisfied only by a routine model. A deep
// requirement may fall through to a stronger security model, but a security
// requirement is never downgraded to a non-security model.
const ACCEPTABLE_TIERS = Object.freeze({
  routine: Object.freeze(['routine']),
  deep: Object.freeze(['deep', 'security']),
  security: Object.freeze(['security']),
});

/** Typed fail-closed routing error. Never mutates Worker availability. */
export class RoutingError extends Error {
  constructor(message, code = 'ROUTING_FAILED') {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
  }
}

/**
 * Validate and normalize a Host model registry into a metadata-only catalog.
 * A malformed registry fails closed instead of silently disabling a guard.
 */
export function normalizeModelRegistry(registry) {
  const models = Array.isArray(registry) ? registry : registry?.models;
  if (!Array.isArray(models) || !models.length) throw new RoutingError('Host model registry is empty', 'EMPTY_REGISTRY');
  const seen = new Map();
  const identities = new Map();
  const normalized = models.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) throw new RoutingError('Model registry entry requires a string id', 'INVALID_REGISTRY');
    if (typeof entry.provider !== 'string' || !entry.provider.trim()) throw new RoutingError(`${entry.id} requires a provider`, 'INVALID_REGISTRY');
    if (!MODEL_TIERS.includes(entry.tier)) throw new RoutingError(`${entry.id} requires tier ${MODEL_TIERS.join('|')}`, 'INVALID_REGISTRY');
    if (entry.eligible !== undefined && typeof entry.eligible !== 'boolean') throw new RoutingError(`${entry.id} eligible must be boolean`, 'INVALID_REGISTRY');
    if (entry.prohibited !== undefined && typeof entry.prohibited !== 'boolean') throw new RoutingError(`${entry.id} prohibited must be boolean`, 'INVALID_REGISTRY');
    if (entry.connectionId !== undefined && (typeof entry.connectionId !== 'string' || !entry.connectionId.trim())) throw new RoutingError(`${entry.id} connectionId must be a non-empty string`, 'INVALID_REGISTRY');
    if (entry.paid !== undefined && typeof entry.paid !== 'boolean') throw new RoutingError(`${entry.id} paid must be boolean`, 'INVALID_REGISTRY');
    if (entry.endpoint !== undefined && (typeof entry.endpoint !== 'string' || !entry.endpoint.trim())) throw new RoutingError(`${entry.id} endpoint must be a non-empty string`, 'INVALID_REGISTRY');
    if (entry.paid) {
      let endpoint;
      try { endpoint = new URL(entry.endpoint); } catch { throw new RoutingError(`${entry.id} paid endpoint must be an absolute HTTP(S) URL`, 'INVALID_REGISTRY'); }
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new RoutingError(`${entry.id} paid endpoint must not contain credentials, query, or fragment`, 'INVALID_REGISTRY');
    }
    const list = seen.get(entry.id) ?? [];
    if (list.length && (!entry.connectionId || list.includes(undefined) || list.includes(entry.connectionId))) throw new RoutingError(`Duplicate/ambiguous model id ${entry.id} requires distinct explicit connection identities`, 'INVALID_REGISTRY');
    list.push(entry.connectionId);
    seen.set(entry.id, list);
    const connSet = identities.get(entry.id) ?? new Set();
    if (entry.connectionId !== undefined) connSet.add(entry.connectionId);
    identities.set(entry.id, connSet);
    const normalized = {
      id: entry.id,
      provider: entry.provider,
      tier: entry.tier,
      cost: Number.isFinite(entry.cost) ? entry.cost : 1,
      eligible: entry.eligible !== false,
      prohibited: entry.prohibited === true,
    };
    if (entry.connectionId !== undefined) normalized.connectionId = entry.connectionId;
    if (entry.paid === true) normalized.paid = true;
    if (entry.endpoint !== undefined) normalized.endpoint = entry.endpoint;
    return normalized;
  });
  normalized.ambiguousIds = new Set([...identities.entries()].filter(([, set]) => set.size > 1).map(([id]) => id));
  return normalized;
}

/**
 * Pure per-action model router.
 *
 * input (all Host-computed, never a Worker self-report):
 *   - provider: native transport (legacy catalog scope)
 *   - connectionId: exact Host connection/account identity
 *   - role, capabilities
 *   - risk: 'normal' | 'high'
 *   - escalate: true after consecutive/escalated failures
 *   - security: true when the selected independent reviewer needs security capability
 *   - unavailable: connection ids or model identities the Host currently quarantines
 *
 * Returns { selectedModel, provider, tier, reason, inputs }. Throws RoutingError
 * (fail closed) when no eligible model satisfies the requirement.
 */
export function routeModel(input = {}, registry) {
  const catalog = normalizeModelRegistry(registry);
  const role = typeof input.role === 'string' ? input.role : 'build';
  const security = input.security === true || (Array.isArray(input.capabilities) && input.capabilities.includes('security'));
  const escalate = input.escalate === true;
  const risk = input.risk === 'high' ? 'high' : 'normal';
  const requiredTier = security ? 'security' : (risk === 'high' || escalate) ? 'deep' : 'routine';
  const acceptable = new Set(ACCEPTABLE_TIERS[requiredTier]);
  const unavailable = new Set(input.unavailable ?? []);
  const provider = typeof input.provider === 'string' && input.provider ? input.provider : undefined;
  const connectionId = typeof input.connectionId === 'string' && input.connectionId ? input.connectionId : undefined;
  const ambiguousIds = catalog.ambiguousIds ?? new Set();
  const candidates = catalog.filter(model => {
    if (!model.eligible || model.prohibited || !acceptable.has(model.tier)) return false;
    if (provider !== undefined && model.provider !== provider) return false;
    if (model.connectionId !== undefined && connectionId !== undefined && model.connectionId !== connectionId) return false;
    const modelConnection = model.connectionId ?? model.provider;
    if (unavailable.has(modelConnection)) return false;
    if (unavailable.has(`${modelConnection}::${model.id}`)) return false;
    if (connectionId !== undefined && unavailable.has(`${connectionId}::${model.id}`)) return false;
    if (!ambiguousIds.has(model.id) && unavailable.has(model.id)) return false;
    return true;
  });
  if (!candidates.length) throw new RoutingError(`No eligible ${requiredTier}-tier model${provider ? ` for provider ${provider}` : ''} in the Host registry`, 'NO_ELIGIBLE_MODEL');
  candidates.sort((a, b) => (a.tier === requiredTier ? 0 : 1) - (b.tier === requiredTier ? 0 : 1) || a.cost - b.cost || a.id.localeCompare(b.id));
  const chosen = candidates[0];
  const reason = security ? 'security review routed to an eligible security-tier model'
    : escalate ? 'consecutive/escalated failure routed to an eligible higher-tier model'
      : risk === 'high' ? 'high-risk action routed to an eligible higher-tier model'
        : 'routine action routed to the routine-tier default';
  const result = {
    selectedModel: chosen.id,
    provider: chosen.provider,
    tier: chosen.tier,
    reason,
    inputs: { role, risk, escalate, security, requiredTier, provider: provider ?? null },
  };
  if (chosen.connectionId !== undefined || connectionId !== undefined) {
    result.connectionId = chosen.connectionId ?? connectionId;
    result.inputs.connectionId = connectionId ?? null;
  }
  if (chosen.paid === true) result.paid = true;
  if (chosen.endpoint !== undefined) result.endpoint = chosen.endpoint;
  return result;
}

/**
 * Pure shared-quota helper. A Worker is unavailable when it is itself offline or
 * when any Worker in the same Host-declared `quotaGroup` is offline, so a
 * Codex-backed Pi shares Codex's budget instead of being counted separately.
 */
export function unavailableAgentIds(agents = []) {
  const unavailable = new Set();
  const groups = new Map();
  for (const agent of agents) {
    if (!agent) continue;
    if (agent.availability === 'offline') unavailable.add(agent.id);
    const group = agent.quotaGroup;
    if (typeof group !== 'string' || !group) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(agent);
  }
  for (const members of groups.values()) {
    if (members.some(agent => agent.availability === 'offline')) for (const agent of members) unavailable.add(agent.id);
  }
  return unavailable;
}
