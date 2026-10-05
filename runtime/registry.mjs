import { unavailableAgentIds } from './routing.mjs';

export class AgentRegistry {
  constructor() { this.agents = new Map(); }
  add(adapter) {
    if (!adapter.id || typeof adapter.start !== 'function' || this.agents.has(adapter.id)) throw new Error('Invalid or duplicate adapter');
    this.agents.set(adapter.id, adapter); return adapter;
  }
  get(id) { const agent = this.agents.get(id); if (!agent) throw new Error(`Unknown agent ${id}`); return agent; }
  /** Effective unavailability: own offline state plus every offline quotaGroup member. */
  unavailable() { return unavailableAgentIds([...this.agents.values()]); }
  isUnavailable(id) { return this.unavailable().has(id); }
  select({ role, capabilities = [], risk = 'normal', exclude = [], preferred }, performance = {}) {
    const unavailable = this.unavailable();
    const candidates = [...this.agents.values()].filter(agent => !unavailable.has(agent.id) && agent.roles.includes(role) && !exclude.includes(agent.id) && capabilities.every(c => agent.capabilities.includes(c)));
    const scored = candidates.map(agent => {
      const history = performance[agent.id] ?? { successes: 0, failures: 0 };
      const rate = (history.successes + 1) / (history.successes + history.failures + 2);
      return { agent, score: rate * 4 + agent.trust * (risk === 'high' ? 4 : 1) - (agent.cost ?? 1) * 0.1 + (agent.id === preferred ? 0.2 : 0) - (history.consecutiveFailures ?? 0) };
    }).sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id));
    if (!scored.length) throw new Error(`No available agent for ${role}/${capabilities.join(',')}`);
    return scored[0].agent;
  }
  describe(performance = {}) { return [...this.agents.values()].map(agent => ({ ...agent.describe(), performance: performance[agent.id] ?? { successes: 0, failures: 0 }, permissions: agent.permissions })); }
}

export function updatePerformance(state, id, succeeded, durationMs = 0) {
  const row = state.agentPerformance[id] ??= { successes: 0, failures: 0, consecutiveFailures: 0, durationMs: 0 };
  if (succeeded) { row.successes++; row.consecutiveFailures = 0; }
  else { row.failures++; row.consecutiveFailures++; }
  row.durationMs += durationMs;
}
