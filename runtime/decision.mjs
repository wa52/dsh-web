/** Validate model decisions at the boundary. No worker name or TODO sequence is accepted. */
export function validateAssessment(value) {
  if (!value || !Array.isArray(value.gaps) || !Array.isArray(value.candidates) || typeof value.complete !== 'boolean' || typeof value.reason !== 'string') throw new Error('Invalid project assessment');
  const ids = new Set();
  for (const gap of value.gaps) {
    if (typeof gap.id !== 'string' || ids.has(gap.id) || typeof gap.description !== 'string' || !Number.isFinite(gap.priority) || !Array.isArray(gap.evidence) || !gap.evidence.length) throw new Error('Gap requires identity, priority and evidence');
    ids.add(gap.id);
  }
  for (const candidate of value.candidates) {
    if (typeof candidate.goal !== 'string' || !candidate.goal.trim() || !ids.has(candidate.gapId) || !Array.isArray(candidate.capabilities) || !candidate.capabilities.length || !['normal', 'high'].includes(candidate.risk) || !['retry', 'replace', 'split', 'reprioritize', 'repair'].includes(candidate.strategy)) throw new Error('Invalid candidate action');
  }
  if (value.complete && (value.gaps.length || value.candidates.length)) throw new Error('Complete assessment still contains gaps');
  return value;
}

export const ASSESSMENT_SHAPE = {
  complete: 'boolean, true only when every success criterion has evidence', reason: 'string', currentState: 'object', projectHealth: 'number 0..1',
  gaps: [{ id: 'string', description: 'string', priority: 'number, highest first', evidence: ['test/log/source references'] }],
  candidates: [{ gapId: 'one current gap id', goal: 'one bounded action', capabilities: ['code/debug/ui'], risk: 'normal/high', strategy: 'retry/replace/split/reprioritize/repair', rationale: 'string' }],
};
export const REVIEW_SHAPE = { verdict: 'pass/reject/needs_more_evidence', reason: 'string', evidence: ['source/test references'], blockingRisks: ['string; empty for pass'], findings: [{ description: 'string', priority: 'number' }] };

export class ModelDecision {
  constructor(execute, registry, preferred) { Object.assign(this, { execute, registry, preferred }); }
  async assess(state, observation, workspace) {
    const agent = this.registry.select({ role: 'decide', capabilities: ['reason'], preferred: this.preferred }, state.agentPerformance);
    let report;
    let formatError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        report = await this.execute(agent, {
      role: 'decide', workspace, outputSchema: ASSESSMENT_SHAPE,
      prompt: `Re-evaluate the ENTIRE project now. Ignore old TODO ordering. Diagnose gaps from current evidence and propose independent candidate actions. New regressions outrank cosmetic work. Never claim success just because a Builder did. Do not invent additional success criteria or require unrelated features. Passing ALL supplied criteria with accepted review evidence means complete.\nGoal: ${state.goal}\nCriteria: ${JSON.stringify(state.successCriteria)}\nConstraints: ${JSON.stringify(state.constraints)}\nObservation: ${JSON.stringify(observation)}\nPrevious failures/reviews: ${JSON.stringify(state.failures.slice(-8))}\nActions: ${JSON.stringify(state.actions.slice(-5).map(a => ({ goal: a.goal, phase: a.phase, reviews: a.reviews })))}\nProvide evidence for every gap. For rejected work, diagnose the findings and reconsider the route rather than resuming a stale task.\n${formatError}`,
    });
        validateAssessment(report);
        break;
      } catch (error) {
        if (attempt || !/JSON|assessment|Gap requires|candidate|Complete assessment/.test(error.message)) throw error;
        formatError = `The previous response did not satisfy the JSON contract: ${error.message}. Return one JSON object only, with actual values instead of schema descriptions. No markdown or prose outside JSON.`;
      }
    }
    return { ...validateAssessment(report), decidedBy: agent.id, decisionRunId: report.runId };
  }
}
