import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { DatabaseDeadlineError, DatabaseRecoveringError, WebPool } from './web-pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function driver() {
  const run = vi.fn<(query: string) => Promise<unknown>>().mockResolvedValue([{ value: 1 }]);
  const unsafe = vi.fn((query: string) => {
    const result = query.startsWith('set local') ? Promise.resolve([]) : run(query);
    return Object.assign(result, { values: () => result.then(() => [[1]]) });
  });
  const tx = { unsafe, savepoint: vi.fn(async (callback) => callback(tx)) };
  const raw = Object.assign(() => {}, {
    options: { max: 10, parsers: {}, serializers: {} },
    unsafe,
    begin: vi.fn(async (callback) => callback(tx)),
    end: vi.fn().mockResolvedValue(undefined),
  });
  return {
    raw: raw as unknown as ReturnType<typeof postgres>,
    run,
    tx,
    begin: raw.begin,
    end: raw.end,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('web database budgets', () => {
  const policy = { statementMs: 50, deadlineMs: 100, cooldownMs: 20 };

  it('keeps queries lazy and applies SET LOCAL on their own transaction before execution', async () => {
    const fake = driver();
    const pool = new WebPool(() => fake.raw, policy, vi.fn());
    const query = pool.getSql().unsafe('select 1');
    expect(fake.begin).not.toHaveBeenCalled();
    await expect(query).resolves.toEqual([{ value: 1 }]);
    expect(fake.tx.unsafe.mock.calls.map(([q]) => q)).toEqual([
      "set local statement_timeout = '50ms'",
      'select 1',
    ]);
    expect(fake.end).not.toHaveBeenCalled();
  });

  it('preserves the values() result mode used by Drizzle', async () => {
    const fake = driver();
    const pool = new WebPool(() => fake.raw, policy, vi.fn());
    await expect(pool.getSql().unsafe('select 1').values()).resolves.toEqual([[1]]);
  });

  it('refuses a queue-wait deadline without retiring a pool that is only busy', async () => {
    const fake = driver();
    const queued = deferred<unknown>();
    fake.begin.mockImplementation(() => queued.promise);
    const create = vi.fn().mockReturnValue(fake.raw);
    const report = vi.fn();
    const pool = new WebPool(create, policy, report);
    const client = pool.getSql();
    const result = Promise.resolve(client.unsafe('select sensitive_value')).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(101);
    const error = await result;
    expect(error).toBeInstanceOf(DatabaseDeadlineError);
    // Nothing reached a connection, so the caller knows no write happened.
    expect((error as DatabaseDeadlineError).waitedForConnection).toBe(true);
    expect(fake.tx.unsafe).not.toHaveBeenCalled();
    // Retiring here would reject the rest of the backlog and hand the fresh
    // pool the same backlog after the cooldown.
    expect(fake.end).not.toHaveBeenCalled();
    expect(pool.getSql()).toBe(client);
    expect(JSON.stringify(report.mock.calls)).toContain('queue_deadline');
    expect(JSON.stringify(report.mock.calls)).not.toContain('sensitive_value');
    queued.reject(new Error('late shutdown rejection'));
    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retires on a stalled connection, refuses stale clients and reconnects after cooldown', async () => {
    const first = driver();
    const second = driver();
    const stuck = deferred<unknown>();
    first.run.mockReturnValue(stuck.promise);
    const create = vi.fn().mockReturnValueOnce(first.raw).mockReturnValue(second.raw);
    const report = vi.fn();
    const pool = new WebPool(create, policy, report);
    const stale = pool.getSql();
    const result = Promise.resolve(stale.unsafe('select sensitive_value')).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(101);
    const error = await result;
    expect(error).toBeInstanceOf(DatabaseDeadlineError);
    // It answered BEGIN and then went quiet, so its outcome is unknown.
    expect((error as DatabaseDeadlineError).waitedForConnection).toBe(false);
    expect(first.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    // Typed, because a cooldown is an instruction to wait and a fault is an
    // instruction to surface; a bare Error cannot tell a caller which it has.
    expect(() => pool.getSql()).toThrow(DatabaseRecoveringError);
    try {
      pool.getSql();
    } catch (error) {
      expect((error as DatabaseRecoveringError).retryAfterMs).toBeGreaterThan(0);
      expect((error as DatabaseRecoveringError).retryAfterMs).toBeLessThanOrEqual(
        policy.cooldownMs,
      );
    }
    expect(JSON.stringify(report.mock.calls)).not.toContain('sensitive_value');
    await vi.advanceTimersByTimeAsync(20);
    await expect(pool.getSql().unsafe('select 1')).resolves.toEqual([{ value: 1 }]);
    await expect(Promise.resolve(stale.unsafe('select 1'))).rejects.toBeInstanceOf(
      DatabaseDeadlineError,
    );
    stuck.resolve([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not recycle for 57014 or retry any failed operation', async () => {
    const fake = driver();
    const error = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    fake.run.mockRejectedValueOnce(error);
    const pool = new WebPool(() => fake.raw, policy, vi.fn());
    await expect(pool.getSql().unsafe('update example')).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.end).not.toHaveBeenCalled();
    expect(fake.run).toHaveBeenCalledTimes(1);
    await expect(pool.getSql().unsafe('select 1')).resolves.toEqual([{ value: 1 }]);
  });

  it('gives an explicit transaction one total deadline, including callbacks and savepoints', async () => {
    const fake = driver();
    const pause = deferred<void>();
    const pool = new WebPool(() => fake.raw, policy, vi.fn());
    const result = pool
      .getSql()
      .begin(async (tx) => {
        await tx.unsafe('select 1');
        await tx.savepoint(async (nested) => {
          await nested.unsafe('select 2');
        });
        await pause.promise;
        await tx.unsafe('must not run after retirement');
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBeInstanceOf(DatabaseDeadlineError);
    pause.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.begin).toHaveBeenCalledTimes(1);
    expect(fake.tx.savepoint).toHaveBeenCalledTimes(1);
    expect(fake.run.mock.calls.flat()).toEqual(['select 1', 'select 2']);
  });

  it('cleans up a never-answering query and handles its late completion', async () => {
    const fake = driver();
    const stuck = deferred<unknown>();
    fake.run.mockReturnValue(stuck.promise);
    const pool = new WebPool(() => fake.raw, policy, vi.fn());
    const result = Promise.resolve(pool.getSql().unsafe('select 1')).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBeInstanceOf(DatabaseDeadlineError);
    stuck.resolve([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.end).toHaveBeenCalledTimes(1);
  });
});
