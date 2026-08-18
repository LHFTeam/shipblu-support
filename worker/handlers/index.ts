import type { ClaimedJob, JobType } from '@/lib/queue';
import { cleanup } from './cleanup';
import { downloadMediaJob } from './download-media';
import { importFreshdeskKb } from './import-freshdesk-kb';
import { processWebhook } from './process-webhook';
import { sendEmail } from './send-email';
import { sendWhatsApp } from './send-whatsapp';
import { slaSweep } from './sla-sweep';
import { syncWhatsAppTemplates } from './sync-whatsapp-templates';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/**
 * Job type → handler. Types are registered here as each phase lands; a job whose
 * type has no handler fails loudly rather than being silently dropped, so a
 * half-deployed rename shows up immediately in the dead queue.
 *
 * The rest of phase 3 (automations, CSAT, reporting) registers
 * run_time_automations, send_csat and rollup_metrics here.
 */
export const handlers: Partial<Record<JobType, JobHandler>> = {
  cleanup,
  download_media: downloadMediaJob,
  import_freshdesk_kb: () => importFreshdeskKb(),
  process_webhook: processWebhook,
  send_email: sendEmail,
  send_whatsapp: sendWhatsApp,
  sla_sweep: () => slaSweep(),
  sync_whatsapp_templates: () => syncWhatsAppTemplates(),
};

/**
 * Job types whose cron schedule is already provisioned but whose implementing
 * phase has not landed yet.
 *
 * The Render Blueprint creates every cron job up front, so these fire on
 * schedule before their handler exists. Without this list each firing is a
 * failed cron run — noise that trains everyone to ignore cron failures, which
 * is precisely when a real one gets missed.
 *
 * Deliberately an explicit allowlist rather than "tolerate anything unknown":
 * a typo or a renamed job still fails loudly, which is the property that makes
 * `resolveHandler` worth having.
 */
export const PLANNED_JOB_TYPES = new Set<JobType>([
  'run_time_automations',
  'rollup_metrics',
  'send_csat',
]);

export function isPlannedButUnimplemented(type: string): boolean {
  return !handlers[type as JobType] && PLANNED_JOB_TYPES.has(type as JobType);
}

export function resolveHandler(type: string): JobHandler {
  const handler = handlers[type as JobType];
  if (!handler) {
    throw new Error(`No handler registered for job type "${type}"`);
  }
  return handler;
}
