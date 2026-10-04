/** Bridge the published DSH one-shot contract; leaves its original agent-loop intact. */
export function createDshWorker({ id, identity, roles, subagents, provider, parent, request = {}, readOnly = false }) {
  if (readOnly) throw new Error('Generic DSH tool filters do not enforce filesystem read-only access; use an isolated reviewer adapter');
  if (roles.includes('review')) throw new Error('Generic DSH bridge is Builder-only');
  return {
    id, identity, roles, readOnly: false,
    async start(input) {
      const run = await subagents.start(provider, {
        ...request, parent, signal: input.signal,
        prompt: [{ type: 'text', text: `Complete only this action, then return control. Do not start another project task.\nAction: ${input.actionId}\nGoal: ${input.goal}\nWorkspace: ${input.workspace}` }],
      });
      return {
        result: run.result.then(result => {
          if (result.stopReason !== 'completed') throw new Error(`DSH Worker stopped: ${result.stopReason}`);
          return result;
        }),
        dispose: () => run.dispose(),
      };
    },
  };
}
