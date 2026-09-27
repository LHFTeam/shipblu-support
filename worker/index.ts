import { randomUUID } from 'node:crypto';
import { closeDb, sessionSql } from '@/db/client';
import { env } from '@/lib/env';
import { claimJobs, completeJob, failJob, reclaimStalledJobs } from '@/lib/queue';
import { backoffMs, classifyFailure } from '@/lib/queue/backoff';
import { resolveHandler } from './handlers';
import { logger } from '@/lib/log';

const log = logger('worker');

/**
 * Long-running queue consumer (Render background worker).
 *
 * Waits on a LISTEN notification rather than polling hot, so an agent's reply
 * leaves the queue within milliseconds. The timer is a backstop for scheduled
 * jobs (`run_at` in the future), which no NOTIFY will ever announce.
 */

const workerId = `${process.env.RENDER_INSTANCE_ID ?? 'local'}-${randomUUID().slice(0, 8)}`;

let shuttingDown = false;

/** Cut short by an arriving job. Not registered during an error backoff. */
let wakeOnJob: (() => void) | null = null;
/** Always registered, so shutdown is prompt even mid-backoff. */
let wakeOnShutdown: (() => void) | null = null;

function jobArrived() {
  wakeOnJob?.();
}

/**
 * Resolves after `ms`, or early when woken.
 *
 * `interruptibleByJobs` is false during error backoff. Otherwise a steady
 * trickle of new jobs would cut every backoff short and keep hammering a
 * database that is rejecting us — which is exactly how the auth circuit breaker
 * gets tripped, and what the backoff exists to prevent. Shutdown always
 * interrupts, so a SIGTERM during a ten-minute backoff still exits promptly.
 */
function sleep(ms: number, { interruptibleByJobs = true } = {}): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wakeOnJob = null;
      wakeOnShutdown = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (interruptibleByJobs) wakeOnJob = finish;
    wakeOnShutdown = finish;
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
        log.info(`${job.type} ${job.id} ok in ${Date.now() - started}ms`);
      } catch (error) {
        await failJob(job, error);
        log.error(`${job.type} ${job.id} failed (attempt ${job.attempts})`, error);
      }
    }),
  );

  return claimed.length;
}

async function main() {
  log.info(`starting as ${workerId}`);

  // LISTEN is an optimisation, not a requirement: it lets a queued job start
  // within milliseconds instead of waiting for the next poll. The loop polls
  // regardless, so if the session connection is unavailable the worker degrades
  // to poll-only rather than dying.
  //
  // This was previously unguarded, which meant a bad DATABASE_URL_SESSION threw
  // out of main() and exited the process — the same crash-loop that the startup
  // reclaim below already had to be fixed for.
  let listener: ReturnType<typeof sessionSql> | null = null;
  try {
    listener = sessionSql();
    await listener.listen('job_enqueued', () => jobArrived());
    log.info('listening for job_enqueued');
  } catch (error) {
    log.error('could not LISTEN (check DATABASE_URL_SESSION) — falling back to polling', error);
    // The client can exist even when the LISTEN on it failed, and nulling the
    // reference first threw away the only handle to it — a session connection
    // opened with `idle_timeout: 0`, held until something reaped it. Same leak
    // the two SSE routes had (§62); here it survives for the life of the
    // process, so a restart loop leaked one per attempt.
    if (listener) {
      await listener.end({ timeout: 5 }).catch(() => {
        /* already gone, or never established */
      });
    }
    listener = null;
  }

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
    if (reclaimed > 0) log.info(`reclaimed ${reclaimed} stalled job(s)`);
  } catch (error) {
    log.error('startup reclaim failed, continuing', error);
  }

  const shutdown = (signal: string) => {
    log.info(`${signal} received, finishing current batch`);
    shuttingDown = true;
    wakeOnShutdown?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  let sinceReclaim = Date.now();
  let consecutiveFailures = 0;

  while (!shuttingDown) {
    try {
      const processed = await runOnce();
      consecutiveFailures = 0;

      // Only idle-wait when the queue is empty; otherwise drain it promptly.
      if (processed === 0) await sleep(env().WORKER_POLL_INTERVAL_MS);

      if (Date.now() - sinceReclaim > 5 * 60 * 1000) {
        await reclaimStalledJobs();
        sinceReclaim = Date.now();
      }
    } catch (error) {
      // A failure here is the loop itself — the database being unreachable or
      // refusing us — not a job.
      //
      // The delay depends on *why* it failed. Retrying a wrong password every
      // few seconds achieves nothing and trips Supavisor's shared auth circuit
      // breaker, which then locks the other services out of the database too.
      // A misconfigured worker must degrade quietly, not take the project down.
      consecutiveFailures += 1;
      const kind = classifyFailure(error);
      const delay = backoffMs(kind, consecutiveFailures);

      log.error(
        `loop error (${kind}, attempt ${consecutiveFailures}), ` +
          `retrying in ${Math.round(delay / 1000)}s`,
        error,
      );

      if (kind === 'auth' && consecutiveFailures === 1) {
        log.error(
          'authentication is failing — check DATABASE_URL. Retries will ' +
            'not fix this, so the worker will back off rather than keep trying.',
        );
      }

      await sleep(delay, { interruptibleByJobs: false });
    }
  }

  log.info('shutting down');
  if (listener) await listener.end();
  await closeDb();
  process.exit(0);
}

main().catch((error: unknown) => {
  log.error('fatal', error);
  process.exit(1);
});
