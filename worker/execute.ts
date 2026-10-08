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
 * twice. A success that cannot be recorded is now logged and left alone: the
 * worker stops refreshing its lock once it leaves the pool, so the stalled sweep
 * hands it back within `STALLED_AFTER_MS` if the row really is still ours, which
 * is the queue's ordinary at-least-once promise and no worse.
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
      const recorded = await failJob(job, failure.error);
      log.error(`${job.type} ${job.id} failed (attempt ${job.attempts})`, failure.error);
      if (!recorded) lostHold(job);
      return;
    }

    const recorded = await completeJob(job);
    log.info(`${job.type} ${job.id} ok in ${Date.now() - started}ms`);
    if (!recorded) lostHold(job);
  } catch (error) {
    log.error(
      `${job.type} ${job.id} ${failure ? 'failed' : 'succeeded'} but the outcome was not recorded`,
      error,
    );
  }
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
