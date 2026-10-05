import type { ClaimedJob, JobType } from '@/lib/queue';
import { assignSweep } from './assign-sweep';
import { backfillCategoriseAi } from './backfill-categorise-ai';
import { backfillMessageLocations } from './backfill-message-locations';
import { backfillMetaProfiles } from './backfill-meta-profiles';
import { backfillShipmentLinks } from './backfill-shipment-links';
import { checkMetaPermissions } from './check-meta-permissions';
import { cleanup } from './cleanup';
import { downloadMediaJob } from './download-media';
import { fetchMetaProfile } from './fetch-meta-profile';
import { importFreshdeskKb } from './import-freshdesk-kb';
import { moderateMetaComment } from './moderate-meta-comment';
import { normaliseKbFormatting } from './normalise-kb-formatting';
import { presenceSweep } from './presence-sweep';
import { processWebhook } from './process-webhook';
import { rollupMetrics } from './rollup-metrics';
import { runTimeAutomations } from './run-time-automations';
import { seedCannedResponses } from './seed-canned-responses';
import { seedConsoleHandbook } from './seed-console-handbook';
import { sendCsat } from './send-csat';
import { sendEmail } from './send-email';
import { sendMeta } from './send-meta';
import { sendAgentInvite } from './send-agent-invite';
import { sendNotificationEmail } from './send-notification-email';
import { sendSideEmail } from './send-side-email';
import { sendWhatsApp } from './send-whatsapp';
import { slaSweep } from './sla-sweep';
import { snapshotBacklog } from './snapshot-backlog';
import { subscribeMetaWebhooks } from './subscribe-meta-webhooks';
import { syncShipmentJob } from './sync-shipment';
import { syncStaleShipments } from './sync-stale-shipments';
import { syncWhatsAppTemplates } from './sync-whatsapp-templates';
import { testCommentPermission } from './test-comment-permission';

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
  assign_sweep: () => assignSweep(),
  backfill_categorise_ai: (job) => backfillCategoriseAi(job),
  backfill_message_locations: (job) => backfillMessageLocations(job),
  backfill_meta_profiles: (job) => backfillMetaProfiles(job),
  backfill_shipment_links: (job) => backfillShipmentLinks(job),
  check_meta_permissions: () => checkMetaPermissions(),
  test_comment_permission: (job) => testCommentPermission(job),
  cleanup,
  download_media: downloadMediaJob,
  fetch_meta_profile: fetchMetaProfile,
  import_freshdesk_kb: () => importFreshdeskKb(),
  moderate_meta_comment: moderateMetaComment,
  normalise_kb_formatting: (job) => normaliseKbFormatting(job),
  presence_sweep: () => presenceSweep(),
  process_webhook: processWebhook,
  rollup_metrics: (job) => rollupMetrics(job),
  run_time_automations: () => runTimeAutomations(),
  seed_canned_responses: (job) => seedCannedResponses(job),
  seed_console_handbook: (job) => seedConsoleHandbook(job),
  send_csat: sendCsat,
  send_email: sendEmail,
  send_meta: sendMeta,
  send_agent_invite: sendAgentInvite,
  send_notification_email: sendNotificationEmail,
  send_side_email: sendSideEmail,
  send_whatsapp: sendWhatsApp,
  sla_sweep: () => slaSweep(),
  snapshot_backlog: () => snapshotBacklog(),
  subscribe_meta_webhooks: (job) => subscribeMetaWebhooks(job),
  sync_shipment: (job) => syncShipmentJob(job),
  sync_stale_shipments: (job) => syncStaleShipments(job),
  sync_whatsapp_templates: () => syncWhatsAppTemplates(),
};

/**
 * Job types whose cron schedule is already provisioned but whose implementing
 * phase has not landed yet.
 *
 * Empty as of phase 3: every job the Render Blueprint schedules now has a
 * handler. The mechanism stays because the situation recurs — the blueprint
 * creates cron jobs up front, so the next phase's schedule will fire before its
 * handler exists, and without this each firing is a failed cron run. That noise
 * trains everyone to ignore cron failures, which is precisely when a real one
 * gets missed.
 *
 * Deliberately an explicit allowlist rather than "tolerate anything unknown":
 * a typo or a renamed job still fails loudly, which is the property that makes
 * `resolveHandler` worth having.
 */
export const PLANNED_JOB_TYPES = new Set<JobType>([]);

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
