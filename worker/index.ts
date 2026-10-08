import { randomUUID } from 'node:crypto';
import { closeDb, POOL_MAX, sessionSql } from '@/db/client';
import { env } from '@/lib/env';
import {
  claimJobs,
  HEARTBEAT_EVERY_MS,
  reclaimStalledJobs,
  STALLED_AFTER_MS,
  touchJobs,
} from '@/lib/queue';
import { backoffMs, classifyFailure } from '@/lib/queue/backoff';
import { executeJob } from './execute';
import { effectiveConcurrency, startPool, type Pool } from './pool';
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

/** Set once the pool starts; a NOTIFY before then is covered by its first claim. */
let pool: Pool | null = null;

/**
 * How long the loop waits after its own query failed, by why it failed.
 *
 * Retrying a wrong password every few seconds achieves nothing and trips
 * Supavisor's shared auth circuit breaker, which then locks the other services
 * out of the database too. A misconfigured worker must degrade quietly, not take
 * the project down.
 */
function loopDelay(error: unknown, consecutiveFailures: number): number {
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

  return delay;
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
    await listener.listen('job_enqueued', () => pool?.jobArrived());
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

  // A deploy kills the previous worker mid-job, and the pool's first pass returns
  // those rows to the queue. Not here and not fatal: this used to run unguarded,
  // so a database briefly unreachable at boot took the process down, and Render
  // restarting a dead worker at once turned a blip into a crash loop. In the
  // pool a failing sweep backs off like any other loop error.
  const controller = new AbortController();
  pool = startPool({
    concurrency: effectiveConcurrency(env().WORKER_CONCURRENCY, POOL_MAX),
    pollMs: env().WORKER_POLL_INTERVAL_MS,
    heartbeatMs: HEARTBEAT_EVERY_MS,
    reclaimEveryMs: STALLED_AFTER_MS,
    stalledAfterMs: STALLED_AFTER_MS,
    claim: (limit) => claimJobs(limit, workerId),
    run: executeJob,
    touch: (ids) => touchJobs(ids, workerId),
    reclaim: () => reclaimStalledJobs(),
    loopDelay,
    signal: controller.signal,
  });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, finishing the jobs in flight`);
    controller.abort();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await pool.done;

  log.info('shutting down');
  if (listener) await listener.end();
  await closeDb();
  process.exit(0);
}

main().catch((error: unknown) => {
  log.error('fatal', error);
  process.exit(1);
});
