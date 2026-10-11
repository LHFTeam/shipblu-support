import { completeJob, failJob, type ClaimedJob } from '@/lib/queue';
import { logger } from '@/lib/log';
import { resolveHandler } from './handlers';

const log = logger('worker');

/**
 * Run one claimed job and record how it went. Never rejects: the pool starts a
 * job without awaiting it, and Node 22 ends the process on a rejection nobody
 * handles.
 *
 * The handler's outcome and the writing of it are two separate failures. They
 * used to share one `catch`, so a `completeJob` that could not reach the
 * database sent a job that had *succeeded* to `failJob` — and back into the
 * queue ten seconds later, which for a send is the customer's message going out
 * twice. Now the outcome's write is retried on its own, for about half a
 * minute, while the job still holds its slot and the pool still refreshes its
 * lock — so a database that blinked records the job once. Past that it is
 * logged and left: the lock goes stale, a sweep returns the row five to ten
 * minutes later, and the job runs again. That is the queue's ordinary
 * at-least-once promise, which handlers are written to; what it no longer takes
 * is one dropped write.
 *
 * The two log lines a run ends in are word for word what they were, because
 * Render's log search quotes them.
 */
export async function executeJob(job: ClaimedJob): Promise<void> {
  const started = Date.now();

  let failure: { error: unknown } | null = null;
  try {
    await resolveHandler(job.type)(job);
  } catch (error) {
    failure = { error };
  }

  try {
    if (failure) {
      const { error } = failure;
      const recorded = await persistently(() => failJob(job, error));
      log.error(`${job.type} ${job.id} failed (attempt ${job.attempts})`, error);
      if (!recorded) lostHold(job);
      return;
    }

    const recorded = await persistently(() => completeJob(job));
    log.info(`${job.type} ${job.id} ok in ${Date.now() - started}ms`);
    if (!recorded) lostHold(job);
  } catch (error) {
    log.error(
      `${job.type} ${job.id} ${failure ? 'failed' : 'succeeded'} but the outcome was not recorded`,
      error,
    );
  }
}

/** Waits between tries of the outcome's write: about half a minute in all. */
export const RECORD_RETRY_MS = [1_000, 5_000, 25_000];

/**
 * The write, tried again after each wait in `RECORD_RETRY_MS` if it throws.
 * Both writes are guarded by the attempt that holds the row, so a try that
 * landed but whose answer was lost finds the row done and answers `false` —
 * which reads as lost ownership, the honest reading of a row already written.
 */
async function persistently<T>(write: () => Promise<T>): Promise<T> {
  for (const wait of RECORD_RETRY_MS) {
    try {
      return await write();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return write();
}

/**
 * The row was reclaimed and taken by another run before this one finished, so
 * what this run did was not written over that one. Worth a line: a job that
 * needed longer than the stalled window has run twice.
 */
function lostHold(job: ClaimedJob) {
  log.warn(
    `${job.type} ${job.id} (attempt ${job.attempts}) was taken by another run before it finished; its outcome was not recorded`,
  );
}
