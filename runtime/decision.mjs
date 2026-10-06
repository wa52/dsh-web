/** Validate model decisions at the boundary. No worker name or TODO sequence is accepted. */
export function validateAssessment(value, availableCapabilities) {
  if (!value || !Array.isArray(value.gaps) || !Array.isArray(value.candidates) || typeof value.complete !== 'boolean' || typeof value.reason !== 'string') throw new Error('Invalid project assessment');
  const ids = new Set();
  for (const gap of value.gaps) {
    if (typeof gap.id !== 'string' || ids.has(gap.id) || typeof gap.description !== 'string' || !Number.isFinite(gap.priority) || gap.priority < 0 || gap.priority > 100 || !Array.isArray(gap.evidence) || !gap.evidence.length) throw new Error('Gap requires identity, priority 0..100 (larger is more urgent) and evidence');
    ids.add(gap.id);
  }
  for (const candidate of value.candidates) {
    if (candidate.kind !== undefined && candidate.kind !== 'write') throw new Error('Invalid candidate: only product write actions are executable; governance belongs to Host');
    if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some(capability => typeof capability !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(capability) || (availableCapabilities && !availableCapabilities.has(capability)))) throw new Error('Invalid candidate capabilities: use separate registered capability names, never code/debug');
    if (typeof candidate.goal !== 'string' || !candidate.goal.trim() || !ids.has(candidate.gapId) || !Array.isArray(candidate.capabilities) || !candidate.capabilities.length || !['normal', 'high'].includes(candidate.risk) || !['retry', 'replace', 'split', 'reprioritize', 'repair'].includes(candidate.strategy)) throw new Error('Invalid candidate action');
  }
  if (value.complete && (value.gaps.length || value.candidates.length)) throw new Error('Complete assessment still contains gaps');
  return value;
}

export const ASSESSMENT_SHAPE = {
  complete: 'boolean, true only when every success criterion has evidence', reason: 'string', currentState: 'object', projectHealth: 'number 0..1',
  gaps: [{ id: 'string', description: 'string', priority: 'number 0..100; 100 most urgent, 0 least urgent; larger first', evidence: ['test/log/source references'] }],
  candidates: [{ kind: 'write; product source changes only, never host governance', gapId: 'one current gap id', goal: 'one bounded action', capabilities: ['code', 'debug'], risk: 'normal/high', strategy: 'retry/replace/split/reprioritize/repair', rationale: 'string' }],
};
export const REVIEW_SHAPE = { verdict: 'pass/reject/needs_more_evidence', reason: 'string', evidence: ['source/test references'], blockingRisks: ['string; empty for pass'], findings: [{ description: 'string', priority: 'number' }] };

export class ModelDecision {
  constructor(execute, registry, preferred) { Object.assign(this, { execute, registry, preferred }); }
  async assess(state, observation, workspace) {
    const recent = state.actions.slice(-2);
    const escalate = state.riskLevel === 'high' || (recent.length === 2 && recent.every(action => ['FAILED', 'REJECTED', 'NO_CHANGE'].includes(action.phase)));
    const preference = typeof this.preferred === 'function' ? this.preferred() : this.preferred;
    const preferred = preference && preference !== 'auto' ? preference : (escalate ? 'codex' : 'dsh');
    const primary = this.registry.agents.get(preferred);
    const unavailable = this.registry.unavailable();
    const viable = primary?.roles.includes('decide') && primary.capabilities.includes('reason') && this.registry.eligible(primary) && !unavailable.has(preferred) && (typeof this.preferred === 'function' || (state.agentPerformance[preferred]?.consecutiveFailures ?? 0) < 2);
    let agent = viable ? primary : this.registry.select({ role: 'decide', capabilities: ['reason'], risk: escalate ? 'high' : 'normal' }, state.agentPerformance);
    const capabilities = new Set([...this.registry.agents.values()].flatMap(agent => agent.capabilities));
    let report;
    let routing;
    let formatError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        report = await this.execute(agent, {
      role: 'decide', workspace, outputSchema: ASSESSMENT_SHAPE,
      // Host-computed routing inputs; a decide Worker can never escalate its own tier.
      risk: escalate ? 'high' : 'normal', escalate,
      onWorkerSelected: selected => { agent = selected; },
      onRouting: selection => { routing = selection; },
      prompt: `Re-evaluate the ENTIRE project now. The primary use case is developing NEW products from a brief and an initial repository; improving existing products is also supported. Missing product capabilities, core journeys, UI/UX and delivery conditions are gaps even when there is no existing bug or source to repair. Choose the most valuable bounded construction or improvement action for the current state, without a fixed scaffold/frontend/backend sequence. No existing code, no failing tests or an empty TODO list does not prove the requested product exists. Ignore old TODO ordering. Diagnose gaps from current evidence and propose independent candidate actions. Priority is 0..100, with 100 most urgent; larger values first. Propose product changes only: review, commit, deploy and scheduling are Controller duties, not Builder actions. Source coverage explicitly reports missing or truncated files; do not infer absent code from missing excerpts. New regressions outrank cosmetic work. Never claim success just because a Builder did. Do not invent additional success criteria or require unrelated features. Passing ALL supplied criteria with accepted review evidence means complete.\nGoal: ${state.goal}\nCriteria: ${JSON.stringify(state.successCriteria)}\nConstraints: ${JSON.stringify(state.constraints)}\nObservation: ${JSON.stringify(observation)}\nPrevious failures/reviews: ${JSON.stringify(state.failures.slice(-8))}\nActions: ${JSON.stringify(state.actions.slice(-5).map(a => ({ goal: a.goal, phase: a.phase, reviews: a.reviews })))}\nProvide evidence for every gap. For rejected work, diagnose the findings and reconsider the route rather than resuming a stale task.\n${formatError}`,
    });
        if (typeof this.preferred === 'function' && report.worker && this.registry.agents.has(report.worker)) agent = this.registry.get(report.worker);
        validateAssessment(report, capabilities);
        if (report.complete && observation.head !== observation.acceptedHead) throw new Error('Invalid assessment: candidate is not independently accepted; completion is forbidden while review is rejected or pending');
        break;
      } catch (error) {
        if (!attempt && this.registry.isUnavailable(agent.id)) {
          agent = this.registry.select({ role: 'decide', capabilities: ['reason'], exclude: [agent.id] }, state.agentPerformance);
          continue;
        }
        if (attempt || !/JSON|assessment|Gap requires|candidate|Complete assessment/.test(error.message)) throw error;
        formatError = `The previous response did not satisfy the JSON contract: ${error.message}. Return one JSON object only, with actual values instead of schema descriptions. No markdown or prose outside JSON.`;
      }
    }
    return { ...validateAssessment(report, capabilities), decidedBy: agent.id, decisionRunId: report.runId, ...(routing ? { routing } : {}) };
  }
}
