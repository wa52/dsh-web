import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { createPaidApiGrant, revokePaidApiGrant } from '../runtime/paid-authorization.mjs';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

if (args.includes('--help') || !value('--state-dir') || (!args.includes('--grant') && !value('--revoke'))) {
  console.log('Host operator only (interactive; no HTTP grant endpoint):\n'
    + 'Grant: node scripts/paid-api-authorization.mjs --state-dir <external-dir> --grant --project <repo> --connection <id> --models <comma-separated-exact-ids> --endpoint <url> --expires <ISO-8601> --max-worker-runs <positive-int>\n'
    + 'Revoke: node scripts/paid-api-authorization.mjs --state-dir <external-dir> --revoke <grant-id>');
  process.exitCode = args.includes('--help') ? 0 : 2;
} else {
  if (!stdin.isTTY) throw new Error('Paid API authorization requires an interactive Host terminal for human approval');
  const stateDir = path.resolve(value('--state-dir'));
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    if (args.includes('--grant')) {
      const project = value('--project');
      const connectionId = value('--connection');
      const models = (value('--models') ?? '').split(',').map(item => item.trim()).filter(Boolean);
      const endpoint = value('--endpoint');
      const expiresAt = value('--expires');
      const maxWorkerRuns = Number(value('--max-worker-runs'));
      if (!project || !connectionId || !endpoint || !expiresAt || !Number.isSafeInteger(maxWorkerRuns) || maxWorkerRuns < 1 || !models.length) throw new Error('All grant fields are required and max-worker-runs must be a positive integer');
      console.log(JSON.stringify({ project: path.resolve(project), connectionId, models, endpoint, expiresAt, maxWorkerRuns }, null, 2));
      const approval = await terminal.question(`Type APPROVE ${connectionId} to authorize this exact scope: `);
      if (approval !== `APPROVE ${connectionId}`) throw new Error('Human approval was not confirmed; no grant created');
      const grant = await createPaidApiGrant(stateDir, { project, connectionId, models, endpoint, expiresAt, maxWorkerRuns });
      console.log(JSON.stringify({ status: 'granted', ...grant }, null, 2));
    } else {
      const id = value('--revoke');
      const approval = await terminal.question(`Type REVOKE ${id} to revoke this grant: `);
      if (approval !== `REVOKE ${id}`) throw new Error('Human revocation was not confirmed; grant unchanged');
      console.log(JSON.stringify({ status: 'revoked', ...await revokePaidApiGrant(stateDir, id) }, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { terminal.close(); }
}
