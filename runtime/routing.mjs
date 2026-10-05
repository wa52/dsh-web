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
  const seen = new Set();
  return models.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) throw new RoutingError('Model registry entry requires a string id', 'INVALID_REGISTRY');
    if (typeof entry.provider !== 'string' || !entry.provider.trim()) throw new RoutingError(`${entry.id} requires a provider`, 'INVALID_REGISTRY');
    if (!MODEL_TIERS.includes(entry.tier)) throw new RoutingError(`${entry.id} requires tier ${MODEL_TIERS.join('|')}`, 'INVALID_REGISTRY');
    if (entry.eligible !== undefined && typeof entry.eligible !== 'boolean') throw new RoutingError(`${entry.id} eligible must be boolean`, 'INVALID_REGISTRY');
    if (entry.prohibited !== undefined && typeof entry.prohibited !== 'boolean') throw new RoutingError(`${entry.id} prohibited must be boolean`, 'INVALID_REGISTRY');
    if (seen.has(entry.id)) throw new RoutingError(`Duplicate model id ${entry.id}`, 'INVALID_REGISTRY');
    seen.add(entry.id);
    return {
      id: entry.id,
      provider: entry.provider,
      tier: entry.tier,
      cost: Number.isFinite(entry.cost) ? entry.cost : 1,
      eligible: entry.eligible !== false,
      prohibited: entry.prohibited === true,
    };
  });
}

/**
 * Pure per-action model router.
 *
 * input (all Host-computed, never a Worker self-report):
 *   - provider: restrict to the already-selected Worker's provider
 *   - role, capabilities
 *   - risk: 'normal' | 'high'
 *   - escalate: true after consecutive/escalated failures
 *   - security: true when the selected independent reviewer needs security capability
 *   - unavailable: provider ids or model ids the Host currently quarantines
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
  const candidates = catalog.filter(model => model.eligible && !model.prohibited && acceptable.has(model.tier)
    && (provider === undefined || model.provider === provider)
    && !unavailable.has(model.provider) && !unavailable.has(model.id));
  if (!candidates.length) throw new RoutingError(`No eligible ${requiredTier}-tier model${provider ? ` for provider ${provider}` : ''} in the Host registry`, 'NO_ELIGIBLE_MODEL');
  candidates.sort((a, b) => (a.tier === requiredTier ? 0 : 1) - (b.tier === requiredTier ? 0 : 1) || a.cost - b.cost || a.id.localeCompare(b.id));
  const chosen = candidates[0];
  const reason = security ? 'security review routed to an eligible security-tier model'
    : escalate ? 'consecutive/escalated failure routed to an eligible higher-tier model'
      : risk === 'high' ? 'high-risk action routed to an eligible higher-tier model'
        : 'routine action routed to the routine-tier default';
  return {
    selectedModel: chosen.id,
    provider: chosen.provider,
    tier: chosen.tier,
    reason,
    inputs: { role, risk, escalate, security, requiredTier, provider: provider ?? null },
  };
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
