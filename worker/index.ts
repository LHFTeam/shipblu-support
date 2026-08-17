import { randomUUID } from 'node:crypto';
import { closeDb, sessionSql } from '@/db/client';
import { env } from '@/lib/env';
import { claimJobs, completeJob, failJob, reclaimStalledJobs } from '@/lib/queue';
import { resolveHandler } from './handlers';

/**
 * Long-running queue consumer (Render background worker).
 *
 * Waits on a LISTEN notification rather than polling hot, so an agent's reply
 * leaves the queue within milliseconds. The timer is a backstop for scheduled
 * jobs (`run_at` in the future), which no NOTIFY will ever announce.
 */

const workerId = `${process.env.RENDER_INSTANCE_ID ?? 'local'}-${randomUUID().slice(0, 8)}`;

let shuttingDown = false;
let wake: (() => void) | null = null;

function wakeUp() {
  wake?.();
}

/** Resolves on a job notification or after `ms`, whichever comes first. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

async function runOnce(): Promise<number> {
  const claimed = await claimJobs(env().WORKER_CONCURRENCY, workerId);
  if (claimed.length === 0) return 0;

  // Jobs within a batch are independent, so run them together rather than
  // letting one slow provider call stall the rest of the batch.
  await Promise.all(
    claimed.map(async (job) => {
      const started = Date.now();
      try {
        const handler = resolveHandler(job.type);
        await handler(job);
        await completeJob(job.id);
        console.log(`[worker] ${job.type} ${job.id} ok in ${Date.now() - started}ms`);
      } catch (error) {
        await failJob(job, error);
        console.error(`[worker] ${job.type} ${job.id} failed (attempt ${job.attempts})`, error);
      }
    }),
  );

  return claimed.length;
}

async function main() {
  console.log(`[worker] starting as ${workerId}`);

  const listener = sessionSql();
  await listener.listen('job_enqueued', () => wakeUp());
  console.log('[worker] listening for job_enqueued');

  // A deploy kills the previous worker mid-job; return those rows to the queue.
  //
  // Deliberately non-fatal. This used to run unguarded, so a database that was
  // briefly unreachable at boot took the whole process down — and because Render
  // restarts a dead worker immediately, a transient blip became a crash loop
  // that looked far worse than the underlying problem. The main loop below
  // already retries with a backoff, and it re-runs this sweep every five
  // minutes, so failing here costs nothing but a short delay.
  try {
    const reclaimed = await reclaimStalledJobs();
    if (reclaimed > 0) console.log(`[worker] reclaimed ${reclaimed} stalled job(s)`);
  } catch (error) {
    console.error('[worker] startup reclaim failed, continuing', error);
  }

  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal} received, finishing current batch`);
    shuttingDown = true;
    wakeUp();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  let sinceReclaim = Date.now();

  while (!shuttingDown) {
    try {
      const processed = await runOnce();

      // Only idle-wait when the queue is empty; otherwise drain it promptly.
      if (processed === 0) await sleep(env().WORKER_POLL_INTERVAL_MS);

      if (Date.now() - sinceReclaim > 5 * 60 * 1000) {
        await reclaimStalledJobs();
        sinceReclaim = Date.now();
      }
    } catch (error) {
      // A failure here is the loop itself (usually the database being
      // unreachable), not a job. Back off rather than spinning.
      console.error('[worker] loop error', error);
      await sleep(5000);
    }
  }

  console.log('[worker] shutting down');
  await listener.end();
  await closeDb();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('[worker] fatal', error);
  process.exit(1);
});
