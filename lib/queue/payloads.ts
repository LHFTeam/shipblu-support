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
