import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runSupervisedController } from '../runtime/supervisor.mjs';
import { redact } from '../runtime/process.mjs';

const configArgument = process.argv[2];
if (!configArgument || process.argv.includes('--help')) {
  console.log('Usage: node scripts/supervise-controller.mjs <supervisor-config.json>');
  process.exitCode = configArgument ? 0 : 2;
} else {
  const configPath = path.resolve(configArgument);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (Object.hasOwn(config, 'env')) throw new Error('Do not put credentials or environment values in supervisor config; inherit the Host process environment');
  const base = path.dirname(configPath);
  const resolveConfiguredPath = value => typeof value === 'string' && !path.isAbsolute(value) ? path.resolve(base, value) : value;
  try {
    const result = await runSupervisedController({
      ...config,
      cwd: resolveConfiguredPath(config.cwd),
      stateDir: resolveConfiguredPath(config.stateDir),
      finalReportPath: resolveConfiguredPath(config.finalReportPath),
      resultPath: resolveConfiguredPath(config.resultPath),
    });
    console.log(JSON.stringify({ status: result.status, report: resolveConfiguredPath(config.resultPath) ?? path.join(resolveConfiguredPath(config.stateDir), 'supervisor-result.json'), lastDurablePhase: result.lastDurablePhase, failureType: result.failureType }, null, 2));
    if (result.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    // Configuration and atomic-report failures stay visible; never disguise a
    // failed write as a successful supervised run.
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
