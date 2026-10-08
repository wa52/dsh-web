// Local OpenCode protocol fixture: capture the selected model, never call a provider.
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.DSH_AGENT_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(`${JSON.stringify({ type: 'text', part: { text: JSON.stringify({ summary: 'fixture response' }) } })}\n`);
