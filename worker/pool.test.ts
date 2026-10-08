import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ClaimedJob } from '@/lib/queue';
import { effectiveConcurrency, startPool, type PoolDeps } from './pool';

/**
 * The pool's timing, with the clock and every job's end in the test's hands.
 *
 * The property the pool exists for is the first test: a slow job holds its own
 * slot and nothing else. The rest pin what taking the batch barrier away could
 * break — the query rate on an empty queue, the poll that finds retries, the
 * backoff that keeps a refused worker off the database, the heartbeat that
 * keeps the sweep off running jobs, and the drain on shutdown.
 */

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function job(id: string, priority = 100): ClaimedJob {
  return {
    id,
    type: 'send_email',
    payload: {},
    status: 'processing',
    priority,
    runAt: new Date(),
    attempts: 1,
    maxAttempts: 5,
    lastError: null,
    dedupeKey: null,
    lockedAt: new Date(),
    lockedBy: 'worker-a',
    completedAt: null,
    createdAt: new Date(),
  };
}

const POLL = 1_000;
const HEARTBEAT = 60_000;
const RECLAIM = 300_000;
const BACKOFF = 10_000;

type Mocks = {
  claim: Mock<PoolDeps['claim']>;
  run: Mock<PoolDeps['run']>;
  touch: Mock<PoolDeps['touch']>;
  reclaim: Mock<PoolDeps['reclaim']>;
  loopDelay: Mock<PoolDeps['loopDelay']>;
};

function harness(overrides: Partial<Omit<PoolDeps, keyof Mocks | 'signal'> & Mocks> = {}) {
  const queue: ClaimedJob[] = [];
  const runs = new Map<string, Deferred<void>>();
  const controller = new AbortController();

  const deps = {
    concurrency: 2,
    pollMs: POLL,
    heartbeatMs: HEARTBEAT,
    reclaimEveryMs: RECLAIM,
    stalledAfterMs: RECLAIM,
    claim: vi.fn<PoolDeps['claim']>((limit) => Promise.resolve(queue.splice(0, limit))),
    run: vi.fn<PoolDeps['run']>((claimed) => {
      const d = deferred<void>();
      runs.set(claimed.id, d);
      return d.promise;
    }),
    touch: vi.fn<PoolDeps['touch']>((ids) => Promise.resolve(ids)),
    reclaim: vi.fn<PoolDeps['reclaim']>(() => Promise.resolve(0)),
    loopDelay: vi.fn<PoolDeps['loopDelay']>(() => BACKOFF),
    signal: controller.signal,
    ...overrides,
  };

  const pool = startPool(deps);

  return {
    deps,
    pool,
    queue,
    enqueue: (...ids: string[]) => queue.push(...ids.map((id) => job(id))),
    started: () => [...runs.keys()],
    finish: async (id: string) => {
      runs.get(id)!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
    stop: () => controller.abort(),
    tick: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}

let warnings: string[];
let errors: string[];

beforeEach(() => {
  vi.useFakeTimers();
  warnings = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((line: string) => warnings.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => errors.push(line));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startPool', () => {
  it('runs the next job beside a slow one instead of waiting for it', async () => {
    const h = harness();
    h.enqueue('slow', 'fast');
    await h.tick(0);
    expect(h.started()).toEqual(['slow', 'fast']);

    h.enqueue('next');
    await h.finish('fast');

    expect(h.started()).toContain('next');
    expect(h.deps.claim).toHaveBeenLastCalledWith(1);
  });

  it('never runs more than its concurrency, and asks only for the slots free', async () => {
    const h = harness({ concurrency: 3 });
    h.enqueue('a', 'b', 'c', 'd', 'e');
    await h.tick(0);

    expect(h.started()).toEqual(['a', 'b', 'c']);
    expect(h.deps.claim).toHaveBeenCalledWith(3);

    await h.finish('b');
    expect(h.deps.claim).toHaveBeenLastCalledWith(1);
    expect(h.started()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not query for a job finishing on a queue it found empty', async () => {
    const h = harness({ concurrency: 3 });
    h.enqueue('only');
    await h.tick(0);
    expect(h.deps.claim).toHaveBeenCalledTimes(1);

    await h.finish('only');
    expect(h.deps.claim).toHaveBeenCalledTimes(1);

    await h.tick(POLL);
    expect(h.deps.claim).toHaveBeenCalledTimes(2);
  });

  // Retries and future `run_at` rows send no NOTIFY; the poll is all that finds them.
  it('polls on schedule however often jobs finish in between', async () => {
    const h = harness({ concurrency: 3 });
    h.enqueue('a', 'b');
    await h.tick(0);
    expect(h.deps.claim).toHaveBeenCalledTimes(1);

    await h.tick(POLL / 2);
    await h.finish('a');
    await h.tick(POLL / 2 - 1);
    await h.finish('b');
    expect(h.deps.claim).toHaveBeenCalledTimes(1);

    await h.tick(1);
    expect(h.deps.claim).toHaveBeenCalledTimes(2);
  });

  it('claims at once when a job is announced, without waiting for the poll', async () => {
    const h = harness({ pollMs: 60_000 });
    await h.tick(0);
    expect(h.deps.claim).toHaveBeenCalledTimes(1);

    h.enqueue('announced');
    h.pool.jobArrived();
    await h.tick(0);

    expect(h.started()).toEqual(['announced']);
  });

  it('holds an announcement while every slot is taken, and claims when one frees', async () => {
    const h = harness();
    h.enqueue('a', 'b');
    await h.tick(0);
    const claims = h.deps.claim.mock.calls.length;

    h.enqueue('c');
    h.pool.jobArrived();
    await h.tick(0);
    expect(h.deps.claim).toHaveBeenCalledTimes(claims);

    await h.finish('a');
    expect(h.started()).toContain('c');
  });

  it('keeps an announcement that arrives while a claim is in flight', async () => {
    const pending = deferred<ClaimedJob[]>();
    const h = harness({ pollMs: 60_000 });
    await h.tick(0);

    h.deps.claim.mockImplementationOnce(() => pending.promise);
    h.pool.jobArrived();
    await h.tick(0);

    // Enqueued after that claim read the queue, and announced while it ran.
    h.enqueue('late');
    h.pool.jobArrived();
    pending.resolve([]);
    await h.tick(0);

    expect(h.started()).toEqual(['late']);
  });

  it('backs off a refused claim, by count, and only shutdown cuts the backoff short', async () => {
    const refused = new Error('password authentication failed');
    const h = harness();
    h.deps.claim.mockRejectedValueOnce(refused).mockRejectedValueOnce(refused);
    await h.tick(0);
    expect(h.deps.loopDelay).toHaveBeenLastCalledWith(refused, 1);

    // Neither an announcement nor time short of the backoff brings the next try.
    h.pool.jobArrived();
    await h.tick(BACKOFF - 1);
    expect(h.deps.claim).toHaveBeenCalledTimes(1);

    await h.tick(1);
    expect(h.deps.loopDelay).toHaveBeenLastCalledWith(refused, 2);

    await h.tick(BACKOFF);
    expect(h.deps.claim).toHaveBeenCalledTimes(3);

    // A success resets the count.
    h.deps.claim.mockRejectedValueOnce(refused);
    h.pool.jobArrived();
    await h.tick(0);
    expect(h.deps.loopDelay).toHaveBeenLastCalledWith(refused, 1);

    h.stop();
    await h.tick(0);
    await expect(h.pool.done).resolves.toBeUndefined();
  });

  it('sweeps on start and on schedule, even with every slot taken', async () => {
    const h = harness();
    h.enqueue('a', 'b');
    await h.tick(0);
    expect(h.deps.reclaim).toHaveBeenCalledTimes(1);

    await h.tick(RECLAIM);
    expect(h.deps.reclaim).toHaveBeenCalledTimes(2);
    expect(h.started()).toEqual(['a', 'b']);
  });

  it('retries a sweep that failed after the backoff, and claims what a sweep returned', async () => {
    const reclaim = vi
      .fn<PoolDeps['reclaim']>()
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValue(1);
    const h = harness({ pollMs: 60_000, reclaim });
    await h.tick(0);
    expect(h.deps.claim).not.toHaveBeenCalled();

    h.enqueue('reclaimed');
    await h.tick(BACKOFF);
    expect(h.deps.reclaim).toHaveBeenCalledTimes(2);
    expect(h.started()).toEqual(['reclaimed']);
  });

  it('refreshes the locks of exactly the jobs running, on its own timer', async () => {
    const h = harness({ concurrency: 3 });
    await h.tick(HEARTBEAT);
    expect(h.deps.touch).not.toHaveBeenCalled();

    h.enqueue('a', 'b');
    h.pool.jobArrived();
    await h.tick(0);
    await h.finish('a');
    await h.tick(HEARTBEAT);

    expect(h.deps.touch).toHaveBeenCalledWith(['b']);
  });

  // The loop's backoff can outlast the stalled window; the heartbeat must not wait for it.
  it('keeps refreshing locks through a long backoff', async () => {
    const h = harness({ loopDelay: vi.fn<PoolDeps['loopDelay']>(() => 10 * 60_000) });
    h.enqueue('a');
    await h.tick(0);

    h.deps.claim.mockRejectedValue(new Error('too many clients'));
    h.pool.jobArrived();
    await h.tick(0);
    await h.tick(3 * HEARTBEAT);

    expect(h.deps.touch).toHaveBeenCalledTimes(3);
  });

  it('does not stack refreshes while one is still out', async () => {
    const pending = deferred<string[]>();
    const h = harness();
    h.enqueue('a');
    await h.tick(0);
    h.deps.touch.mockImplementationOnce(() => pending.promise);

    await h.tick(3 * HEARTBEAT);
    expect(h.deps.touch).toHaveBeenCalledTimes(1);

    pending.resolve(['a']);
    await h.tick(HEARTBEAT);
    expect(h.deps.touch).toHaveBeenCalledTimes(2);
  });

  it('logs a failed refresh without backing off, and warns of a lock it lost twice', async () => {
    const h = harness();
    h.enqueue('a');
    await h.tick(0);

    h.deps.touch.mockRejectedValueOnce(new Error('timeout'));
    await h.tick(HEARTBEAT);
    expect(warnings.some((line) => line.includes('could not refresh'))).toBe(true);
    expect(h.deps.loopDelay).not.toHaveBeenCalled();

    h.deps.touch.mockResolvedValue([]);
    await h.tick(HEARTBEAT);
    expect(warnings.some((line) => line.includes('no longer held'))).toBe(false);
    await h.tick(HEARTBEAT);
    expect(warnings.filter((line) => line.includes('no longer held'))).toHaveLength(1);
  });

  it('says once that a job has outlived the stalled window', async () => {
    const h = harness();
    h.enqueue('a');
    await h.tick(0);

    await h.tick(RECLAIM + HEARTBEAT);
    await h.tick(HEARTBEAT);
    expect(warnings.filter((line) => line.includes('has run for more than'))).toHaveLength(1);
  });

  it('on shutdown claims nothing more and resolves once the running jobs finish', async () => {
    const h = harness();
    h.enqueue('a');
    await h.tick(0);
    const claims = h.deps.claim.mock.calls.length;

    let done = false;
    void h.pool.done.then(() => (done = true));
    h.stop();
    h.enqueue('b');
    h.pool.jobArrived();
    await h.tick(POLL * 5);

    expect(h.deps.claim).toHaveBeenCalledTimes(claims);
    expect(done).toBe(false);

    // Still refreshing the lock of the job it is waiting for.
    await h.tick(HEARTBEAT);
    expect(h.deps.touch).toHaveBeenCalledWith(['a']);

    await h.finish('a');
    expect(done).toBe(true);

    const beats = h.deps.touch.mock.calls.length;
    await h.tick(HEARTBEAT * 2);
    expect(h.deps.touch).toHaveBeenCalledTimes(beats);
  });

  it('runs the jobs of a claim that was in flight when shutdown came', async () => {
    const pending = deferred<ClaimedJob[]>();
    const h = harness({ claim: vi.fn<PoolDeps['claim']>(() => pending.promise) });
    await h.tick(0);

    h.stop();
    pending.resolve([job('ours')]);
    await h.tick(0);

    expect(h.started()).toEqual(['ours']);
    await h.finish('ours');
    await expect(h.pool.done).resolves.toBeUndefined();
  });

  it('frees the slot of a job whose runner threw anyway, and keeps going', async () => {
    const h = harness({
      concurrency: 1,
      run: vi.fn<PoolDeps['run']>(() => Promise.reject(new Error('runner bug'))),
    });
    h.enqueue('a', 'b');
    await h.tick(0);

    expect(h.deps.run).toHaveBeenCalledTimes(2);
    expect(errors.some((line) => line.includes('escaped its runner'))).toBe(true);
  });
});

describe('effectiveConcurrency', () => {
  it('runs what was asked for while the database pool can carry it', () => {
    expect(effectiveConcurrency(5, 10)).toBe(5);
    expect(effectiveConcurrency(8, 10)).toBe(8);
  });

  it('leaves two connections for the loop and the heartbeat, and says so', () => {
    expect(effectiveConcurrency(20, 10)).toBe(8);
    expect(warnings[0]).toMatch(/WORKER_CONCURRENCY=20/);
  });
});
