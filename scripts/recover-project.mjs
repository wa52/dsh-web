import { readFile } from 'node:fs/promises';
import { recoverInterruptedProject } from '../runtime/recovery.mjs';
if (!process.argv[2]) throw new Error('Usage: node scripts/recover-project.mjs config.local.json');
const state = await recoverInterruptedProject(JSON.parse(await readFile(process.argv[2], 'utf8')));
console.log(JSON.stringify({ status: state.status, phase: state.phase, recovery: state.events.at(-1) }, null, 2));
