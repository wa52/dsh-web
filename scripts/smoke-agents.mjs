import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentAdapter } from '../runtime/adapters.mjs';
import { atomicJson } from '../runtime/store.mjs';

const config = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : {};
const root = path.resolve('.tmp', `agent-smoke-${randomUUID()}`);
await mkdir(root, { recursive: true });
const providers = process.argv[3] ? process.argv[3].split(',') : ['codex', 'opencode', 'pi', 'dsh'];
const results = await Promise.all(providers.map(async provider => {
  const agent = createAgentAdapter(provider, config.agents?.[provider] ?? {});
  let run;
  try {
    run = await agent.start({ role: 'decide', workspace: process.cwd(), artifactDir: path.join(root, provider), runKey: randomUUID(), timeoutMs: 90_000, permissions: { write: false, shell: false, network: false },
      prompt: 'Connectivity smoke test only. Do not call any tools or modify files. Return exactly {"summary":"ready"}.', outputSchema: { summary: 'ready' } });
    const result = await run.result;
    return { provider, status: result.summary === 'ready' ? 'pass' : 'fail', runId: run.id, result, contract: 'native-cli-or-rpc' };
  } catch (error) { return { provider, status: 'fail', error: error.message, runs: agent.describe().runs }; }
  finally { if (run) await run.dispose(); }
}));
const report = path.join(root, 'report.json');
await atomicJson(report, { at: new Date().toISOString(), results });
console.log(JSON.stringify({ report, results: results.map(({ provider, status, error }) => ({ provider, status, error })) }, null, 2));
if (results.some(result => result.status !== 'pass')) process.exitCode = 1;
