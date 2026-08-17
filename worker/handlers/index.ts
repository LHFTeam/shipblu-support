import type { ClaimedJob, JobType } from '@/lib/queue';
import { cleanup } from './cleanup';
import { processWebhook } from './process-webhook';
import { sendEmail } from './send-email';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/**
 * Job type → handler. Types are registered here as each phase lands; a job whose
 * type has no handler fails loudly rather than being silently dropped, so a
 * half-deployed rename shows up immediately in the dead queue.
 *
 * Phase 2 (WhatsApp) registers send_whatsapp, download_media and
 * sync_whatsapp_templates here.
 */
export const handlers: Partial<Record<JobType, JobHandler>> = {
  cleanup,
  process_webhook: processWebhook,
  send_email: sendEmail,
};

export function resolveHandler(type: string): JobHandler {
  const handler = handlers[type as JobType];
  if (!handler) {
    throw new Error(`No handler registered for job type "${type}"`);
  }
  return handler;
}
