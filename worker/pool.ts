import type { ClaimedJob } from '@/lib/queue';
import { logger } from '@/lib/log';

const log = logger('worker');

/**
 * The worker's job pool: up to `concurrency` jobs in flight, and a free slot
 * refilled as soon as a job finishes.
 *
 * It used to claim a batch and await the whole of it before claiming again, so
 * one slow job — a provider at its timeout, a large download — held back every
 * job queued behind it, sends included, for as long as it took
 * (`docs/PROJECT-STATE.md` §6.73). Queue priority could not help: it orders one
 * claim, and nothing was claimed while the batch ran. Now a slow job holds its
 * own slot and nothing else, and each refill takes the most urgent job due.
 *
 * Taking the barrier away exposed what it had been hiding. The stalled-job sweep
 * used to run only between batches, when this worker held nothing; now it runs
 * beside this worker's own jobs, and it hands back any lock older than
 * `STALLED_AFTER_MS` without asking whose. So the pool refreshes the lock of
 * every job it is running (`touchJobs`), on a timer of its own: the loop's error
 * backoff can sit out ten minutes, twice the window, and a heartbeat that waited
 * for it would let the sweep re-run live jobs — the very thing it is there to
 * prevent. The same refresh ends an older double run, where a deploy's new
 * worker swept the old one's long job while it was still going.
 *
 * Nothing here touches the environment or the database — `worker/index.ts`
 * hands both in — so every timing decision below is tested with fake timers.
 */

export type PoolDeps = {
  concurrency: number;
  /** How often to look for work nothing announced: retries and future `run_at` rows. */
  pollMs: number;
  heartbeatMs: number;
  reclaimEveryMs: number;
  /** A job running longer than this is logged once, since nothing will end it but itself. */
  stalledAfterMs: number;
  claim(limit: number): Promise<ClaimedJob[]>;
  /** Runs one job and records its outcome. Expected never to reject. */
  run(job: ClaimedJob): Promise<void>;
  /** Refreshes the locks of the given jobs and returns the ids it still holds. */
  touch(ids: string[]): Promise<string[]>;
  /** Returns stalled jobs to the queue, never the ones given: this pool is running them. */
  reclaim(running: string[]): Promise<number>;
  /** How long to wait after the loop's own query failed, for the nth time running. */
  loopDelay(error: unknown, consecutiveFailures: number): number;
  /** Aborted to stop claiming; `done` resolves once the jobs in flight finish. */
  signal: AbortSignal;
};

export type Pool = {
  /** A job was enqueued (the `job_enqueued` NOTIFY). */
  jobArrived(): void;
  /** Resolves once the pool has been stopped and every job it started has finished. */
  done: Promise<void>;
};

type Running = {
  job: ClaimedJob;
  startedAt: number;
  settled: Promise<void>;
  /** Heartbeats in a row that found the lock gone. */
  missed: number;
  reportedSlow: boolean;
};

export function startPool(deps: PoolDeps): Pool {
  // One entry per run, not per job id. The same job can be in here twice: if
  // this pool's heartbeat failed for the whole stalled window, another worker's
  // sweep can return a job it is still running, and its next claim take it
  // again. Keyed by id, the second run overwrote the first, the first one's end
  // deleted the second, and the pool then ran past its concurrency, stopped
  // refreshing the live run's lock, and could exit in the middle of it.
  const running = new Set<Running>();
  const stopped = () => deps.signal.aborted;

  // Whether a claim could find anything. A claim that came back short says the
  // due queue is empty, and only a NOTIFY, a reclaim or the poll says otherwise
  // — so a job finishing on an empty queue does not cost a query.
  let mayHaveWork = true;
  // Set by a NOTIFY. A claim's answer describes the queue as it stood when the
  // claim ran, so a job enqueued while it was in flight must survive it coming
  // back short — or the job waits for the poll it was announced to skip.
  let announced = false;

  // One waiter at a time: the loop. A wake with nobody waiting is latched, so a
  // job finishing while a claim is in flight is not lost and the loop does not
  // sleep through a free slot.
  let wakeWaiter: (() => void) | null = null;
  let wakePending = false;

  function wake() {
    if (wakeWaiter) wakeWaiter();
    else wakePending = true;
  }

  /**
   * Resolves after `ms`, or on shutdown, or — when `byWork` — on a wake.
   *
   * Not by work during an error backoff: a steady trickle of jobs would cut
   * every backoff short and keep hammering a database that is refusing us,
   * which trips Supavisor's shared auth circuit breaker (§6.11). The wake stays
   * latched for when the backoff ends.
   */
  function wait(ms: number, { byWork }: { byWork: boolean }): Promise<void> {
    if (stopped()) return Promise.resolve();
    if (byWork && wakePending) {
      wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        deps.signal.removeEventListener('abort', finish);
        if (wakeWaiter === onWake) wakeWaiter = null;
        resolve();
      };
      const onWake = () => {
        wakePending = false;
        finish();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      deps.signal.addEventListener('abort', finish, { once: true });
      if (byWork) wakeWaiter = onWake;
    });
  }

  function start(job: ClaimedJob) {
    if (runningIds().includes(job.id)) {
      log.warn(
        `${job.type} ${job.id} was claimed again (attempt ${job.attempts}) while this worker still runs an earlier attempt`,
      );
    }
    const entry: Running = {
      job,
      startedAt: Date.now(),
      settled: Promise.resolve(),
      missed: 0,
      reportedSlow: false,
    };
    entry.settled = Promise.resolve()
      .then(() => deps.run(job))
      .catch((error: unknown) => {
        // `run` records every outcome itself; anything reaching here is a bug
        // in it, and must not become an unhandled rejection that ends the worker.
        log.error(`${job.type} ${job.id} escaped its runner`, error);
      })
      .finally(() => {
        running.delete(entry);
        wake();
      });
    running.add(entry);
  }

  function runningIds(): string[] {
    return [...new Set([...running].map((entry) => entry.job.id))];
  }

  async function beat() {
    const entries = [...running];
    const ids = runningIds();
    if (ids.length === 0) return;
    try {
      const held = new Set(await deps.touch(ids));
      for (const entry of entries) {
        if (!running.has(entry)) continue; // finished while the refresh was in flight
        const { job } = entry;
        const id = job.id;

        // Two misses rather than one: a job can finish between the list being
        // read and the refresh landing, and be gone from the map only a moment
        // after the answer arrives.
        entry.missed = held.has(id) ? 0 : entry.missed + 1;
        if (entry.missed === 2) {
          log.warn(
            `${job.type} ${job.id} (attempt ${job.attempts}) is no longer held by this worker; another run may have it`,
          );
        }

        if (!entry.reportedSlow && Date.now() - entry.startedAt > deps.stalledAfterMs) {
          entry.reportedSlow = true;
          log.warn(
            `${job.type} ${job.id} has run for more than ${Math.round(deps.stalledAfterMs / 60_000)} min; only its own deadlines will end it`,
          );
        }
      }
    } catch (error) {
      // Logged, not backed off: the next beat tries again, and four can be
      // missed before the sweep takes a running job for an orphan.
      log.warn(`could not refresh the locks of ${ids.length} running job(s)`, error);
    }
  }

  let beating: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (beating) return;
    beating = beat().finally(() => {
      beating = null;
    });
  }, deps.heartbeatMs);

  async function loop() {
    let consecutiveFailures = 0;
    // The first pass sweeps, for the rows of a worker that died more than
    // `STALLED_AFTER_MS` ago. One that died a moment ago — a deploy's previous
    // worker — refreshed its locks within the last beat, so its rows come back
    // at a later sweep, once they have gone unrefreshed for the whole window.
    // Never this pool's own runs: a failed heartbeat must not hand back a job
    // that is still going.
    let nextReclaimAt = 0;
    let nextPollAt = 0;

    while (!stopped()) {
      let free = deps.concurrency - running.size;
      try {
        let queried = false;

        if (Date.now() >= nextReclaimAt) {
          const reclaimed = await deps.reclaim(runningIds());
          queried = true;
          nextReclaimAt = Date.now() + deps.reclaimEveryMs;
          if (reclaimed > 0) {
            log.info(`reclaimed ${reclaimed} stalled job(s)`);
            mayHaveWork = true;
          }
        }

        free = deps.concurrency - running.size;
        if (!stopped() && free > 0 && (mayHaveWork || Date.now() >= nextPollAt)) {
          announced = false;
          const claimed = await deps.claim(free);
          queried = true;
          // Absolute, and moved only by a claim: if a wake pushed it back, jobs
          // finishing faster than the interval would postpone the poll forever,
          // and the poll is the only thing that finds a retry or a future
          // `run_at` — neither sends a NOTIFY.
          nextPollAt = Date.now() + deps.pollMs;
          mayHaveWork = claimed.length === free || announced;
          // Started even if shutdown arrived during the claim: the rows are ours
          // now, and the drain waits for them.
          for (const job of claimed) start(job);
        }

        if (queried) consecutiveFailures = 0;
      } catch (error) {
        // The loop's own query failed — the database unreachable or refusing
        // us — not a job. `loopDelay` decides how long by why.
        consecutiveFailures += 1;
        await wait(deps.loopDelay(error, consecutiveFailures), { byWork: false });
        continue;
      }

      free = deps.concurrency - running.size;
      if (free > 0 && mayHaveWork) continue;

      // With every slot taken there is nothing to poll for — a finishing job
      // wakes the loop — but the sweep keeps its schedule.
      const until = free > 0 ? Math.min(nextReclaimAt, nextPollAt) : nextReclaimAt;
      await wait(until - Date.now(), { byWork: true });
    }
  }

  async function drain() {
    while (running.size > 0) {
      await Promise.allSettled([...running].map((entry) => entry.settled));
    }
    // Only now: a job still draining keeps its lock fresh until it is done.
    clearInterval(heartbeat);
    await beating;
  }

  const done = loop()
    .catch((error: unknown) => log.error('the job loop stopped', error))
    .then(drain)
    .catch((error: unknown) => log.error('could not drain the running jobs', error));

  return {
    jobArrived() {
      mayHaveWork = true;
      announced = true;
      wake();
    },
    done,
  };
}

/**
 * How many jobs to run at once, given what was asked for and the database pool.
 *
 * Every running job can hold a connection, and the loop needs one of its own to
 * claim or sweep and the heartbeat another; past the pool's size the extra
 * queries queue, and a query queued past `DB_QUERY_TIMEOUT_MS` is cancelled — a
 * `completeJob` among them. Warned rather than refused: a worker that will not
 * start over a setting crash-loops on Render, which is worse than one running
 * fewer jobs than it was told to.
 */
export function effectiveConcurrency(requested: number, poolMax: number): number {
  const ceiling = Math.max(1, poolMax - 2);
  if (requested <= ceiling) return requested;
  log.warn(
    `WORKER_CONCURRENCY=${requested} needs more than the ${poolMax} database connections allow; running ${ceiling}`,
  );
  return ceiling;
}
