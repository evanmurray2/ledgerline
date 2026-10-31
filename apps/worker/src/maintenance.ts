import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env, MaintenanceParams } from './env.js';

export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, MaintenanceParams> {
  override async run(_event: WorkflowEvent<MaintenanceParams>, _step: WorkflowStep): Promise<unknown> {
    return { ok: true };
  }
}
