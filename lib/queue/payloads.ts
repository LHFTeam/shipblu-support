import { z } from 'zod';
import { PermanentJobError, type ClaimedJob, type JobType } from '@/lib/queue';

/**
 * What a job's payload must hold, written once for the code that enqueues it
 * and the handler that reads it.
 *
 * `jobs.payload` is jsonb, so what a handler is handed is whatever somebody
 * wrote into the row: a caller, a hand-inserted replay, or `npm run job` with
 * its `key=value` arguments. Each handler used to check the fields it needed
 * in its own words — most with `typeof … !== 'string'` and a plain `Error`,
 * which the queue retries five times although no retry can supply a missing
 * id. Checked here, a payload that is wrong fails once, as a
 * `PermanentJobError` naming the field, and `enqueue` is typed from the same
 * schema, so a caller that sends the wrong shape does not compile.
 *
 * A job with no entry takes any object, as every job did before. Entries are
 * added a family at a time, each with its handlers switched over in the same
 * change.
 */
const JOB_PAYLOADS = {
  send_email: z.object({ messageId: z.string() }),
  send_side_email: z.object({ messageId: z.string() }),
  send_whatsapp: z.object({ messageId: z.string() }),
  send_meta: z.object({ messageId: z.string() }),
  send_agent_invite: z.object({ inviteId: z.uuid() }),
  send_notification_email: z.object({
    to: z.email(),
    subject: z.string().min(1),
    textBody: z.string().min(1),
    htmlBody: z.string().min(1),
  }),

  process_webhook: z.object({ webhookEventId: z.string() }),
  send_csat: z.object({ conversationId: z.string().min(1) }),
  // Facebook and Instagram hand over a URL, WhatsApp an id to exchange for one.
  // The WhatsApp half names no source, so a Meta payload that lost its URL
  // matches neither half rather than being read as WhatsApp media.
  download_media: z.union([
    z.object({
      source: z.literal('meta'),
      messageId: z.string(),
      url: z.string().min(1),
      index: z.number().optional(),
    }),
    z.object({
      source: z.undefined().optional(),
      messageId: z.string(),
      mediaId: z.string(),
    }),
  ]),
  moderate_meta_comment: z.object({
    messageId: z.string(),
    action: z.enum(['hide', 'unhide', 'delete']),
    // Absent when the system moderates rather than an agent.
    agentId: z.string().nullish(),
  }),
  fetch_meta_profile: z.object({
    contactId: z.string(),
    platform: z.enum(['facebook', 'instagram']),
    userId: z.string(),
    /** Re-read a profile already on file. Used by the backfill, never by ingest. */
    force: z.boolean().optional(),
  }),
  sync_shipment: z
    .object({
      shipmentId: z.string().optional(),
      /*
       * A number as well as a string, because `npm run job -- sync_shipment
       * trackingNumber=1755021358719` never reaches here as a string: `parsePayload`
       * coerces anything numeric-looking, and every real ShipBlu number is thirteen
       * digits of exactly that shape. It survives the round trip intact — thirteen
       * digits is well inside `Number.MAX_SAFE_INTEGER` — but it arrives typed as a
       * number, and a bare `typeof === 'string'` check would reject the one form an
       * operator is most likely to type.
       */
      trackingNumber: z.union([z.string(), z.number().transform(String)]).optional(),
      force: z.boolean().optional(),
    })
    .refine((payload) => payload.shipmentId || payload.trackingNumber, {
      message: 'requires a shipmentId or a trackingNumber',
    }),

  // The jobs an operator runs by hand, whose options arrive from `npm run job`'s
  // `key=value` parser: `true` and `false` as booleans, anything numeric as a
  // number, the rest as strings. An option that is present but wrong is
  // refused rather than read as absent, because absent is always the default
  // and a default is a real run: `limit=abc` would otherwise walk the archive.
  backfill_meta_profiles: z.object({
    /** Re-read profiles already on file, rather than only the ones never asked. */
    force: z.boolean().optional(),
    /** Stop after this many contacts. Absent means all of them. */
    limit: z.number().int().positive().optional(),
  }),
  sync_stale_shipments: z.object({
    /** Stop after this many parcels. Absent means the handler's `DEFAULT_LIMIT`. */
    limit: z.number().int().positive().optional(),
    /**
     * Also re-read parcels synced longer ago than this, in minutes.
     *
     * Absent by default, and that is a decision rather than a gap. How often a
     * moving parcel should be re-read is a question about the platform's rate
     * limits and about how fresh a status has to be, and nobody has answered
     * either — so the cadence is the operator's to set here or in a cron
     * schedule, not one for this file to invent. See PROJECT-STATE §6.
     */
    staleMinutes: z.number().positive().optional(),
  }),
  rollup_metrics: z.object({
    /** A single day, as `YYYY-MM-DD`. */
    day: z.iso.date().optional(),
    /** Range start, inclusive. Defaults to the oldest day with any data. */
    from: z.iso.date().optional(),
    /** Range end, inclusive. Clamped to yesterday — today is never complete. */
    to: z.iso.date().optional(),
    /** The last N complete days, as an alternative to naming `from`. */
    days: z.number().positive().optional(),
  }),
} satisfies Partial<Record<JobType, z.ZodType>>;

type CheckedJob = keyof typeof JOB_PAYLOADS;

/** What a caller must hand `enqueue` for a job of this type. */
export type JobPayload<T extends JobType> = T extends CheckedJob
  ? z.input<(typeof JOB_PAYLOADS)[T]>
  : Record<string, unknown>;

/**
 * The job's payload, checked against its type's schema.
 *
 * Throws `PermanentJobError`, so a malformed payload goes to `dead` on its first
 * attempt with the reason in `last_error` rather than spending its retries.
 */
export function parseJobPayload<T extends CheckedJob>(
  job: ClaimedJob,
  type: T,
): z.output<(typeof JOB_PAYLOADS)[T]> {
  const parsed = JOB_PAYLOADS[type].safeParse(job.payload);
  if (!parsed.success) {
    throw new PermanentJobError(`${type}: invalid payload — ${parsed.error.message}`);
  }
  return parsed.data as z.output<(typeof JOB_PAYLOADS)[T]>;
}
