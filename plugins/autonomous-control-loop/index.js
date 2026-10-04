import { Service } from '@deepseek-ai/cordis';
import { AutonomousControlLoop } from './controller.js';
export { AutonomousControlLoop } from './controller.js';
export { createDshWorker } from './dsh-worker.js';
export { gitSnapshot } from './git-snapshot.js';

export const name = 'autonomous-control-loop';

/** Host API only. Policy and isolation adapters are installed by trusted plugins. */
export function apply(ctx) {
  class ControlService extends Service {
    constructor() { super(ctx, 'autonomousControl'); this.controllers = new Set(); }
    create(options) {
      const loop = new AutonomousControlLoop(options);
      this.controllers.add(loop);
      return loop;
    }
  }
  const service = new ControlService();
  ctx.on('dispose', async () => {
    await Promise.all([...service.controllers].map(loop => loop.close()));
  });
  return service;
}
