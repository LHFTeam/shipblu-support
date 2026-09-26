import { PermanentJobError } from '@/lib/queue';

/**
 * The failure for a job whose subject row no longer exists.
 *
 * Every enqueue of a per-message job happens after the insert that created the
 * row has committed, so a worker can never race ahead of its own subject: a
 * missing row is not "not yet", it is "not any more". The one thing that
 * removes these rows is an admin purge (`lib/admin/purge.ts`), and a purge
 * cancels the pending jobs it can see — but a job already claimed by a worker
 * is invisible to it, and it comes back here.
 *
 * A plain `Error` would retry that job for its full budget — minutes to an
 * hour of backoff, re-reading a row that cannot come back — before it reached
 * `dead` anyway. Permanent from the first attempt says the same thing at once,
 * and the dead row it leaves names the subject, which is what somebody reading
 * the queue after a purge (or after a genuinely wrong id) needs to see.
 */
export function subjectGone(job: string, subject: string): PermanentJobError {
  return new PermanentJobError(`${job}: ${subject} no longer exists — purged, or never written`);
}
