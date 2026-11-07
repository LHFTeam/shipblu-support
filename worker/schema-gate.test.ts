import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { GATE_TIMEOUT_MS, jobWaitPolicy, readJournal, waitForMigrations } from './schema-gate';

const JOURNAL = [
  { tag: '0059_copy', when: 1_000 },
  { tag: '0060_drop', when: 2_000 },
];

/** A clock that only moves when the gate sleeps, so a wait costs no real time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn((ms: number) => {
      t += ms;
      return Promise.resolve();
    }),
  };
}

/** Answers in turn, repeating the last one for as long as it is asked. */
function answers(...values: (number | null | Error)[]) {
  let i = 0;
  return vi.fn(() => {
    const value = values[Math.min(i++, values.length - 1)];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? null);
  });
}

let info: MockInstance;
let warn: MockInstance;

beforeEach(() => {
  info = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('waitForMigrations', () => {
  it("starts at once when the database has the build's newest migration", async () => {
    const clock = fakeClock();
    await waitForMigrations({ journal: JOURNAL, readApplied: answers(2_000), ...clock });

    expect(clock.sleep).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('starts at once on a database ahead of the build, as after a rollback', async () => {
    const clock = fakeClock();
    await waitForMigrations({ journal: JOURNAL, readApplied: answers(3_000), ...clock });

    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('waits while the web service migrates, and starts once it has', async () => {
    const clock = fakeClock();
    const readApplied = answers(1_000, 1_000, 2_000);
    await waitForMigrations({ journal: JOURNAL, readApplied, ...clock });

    expect(readApplied).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls).toEqual([[5_000], [5_000]]);
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      "[schema_gate] waiting for migration 0060_drop, which the web service's preDeploy applies database_has=0059_copy",
      '[schema_gate] 0060_drop is applied, starting waited_s=10',
    ]);
  });

  it('reads a database no migration has touched as behind, not as ready', async () => {
    const clock = fakeClock();
    await waitForMigrations({ journal: JOURNAL, readApplied: answers(null, 2_000), ...clock });

    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('database_has=none');
  });

  it('gives up after the timeout, naming the migration it waited for', async () => {
    const clock = fakeClock();
    await expect(
      waitForMigrations({ journal: JOURNAL, readApplied: answers(1_000), ...clock }),
    ).rejects.toThrow(/gave up after 15 minutes waiting for migration 0060_drop/);

    // It waited the whole timeout, saying so once a minute, and not past it.
    expect(clock.now()).toBe(GATE_TIMEOUT_MS);
    expect(info).toHaveBeenCalledTimes(15);
  });

  it('backs off a failed read as the worker loop does, rather than polling it', async () => {
    const clock = fakeClock();
    const refused = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    await waitForMigrations({ journal: JOURNAL, readApplied: answers(refused, 2_000), ...clock });

    // An auth failure's first backoff is 30s ± 20%, not the 5s poll: hammering
    // the pooler with a bad password trips Supavisor's shared circuit breaker.
    const [[delay]] = clock.sleep.mock.calls as [[number]];
    expect(delay).toBeGreaterThanOrEqual(24_000);
    expect(delay).toBeLessThanOrEqual(36_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.at(-1)?.[0]).toContain('0060_drop is applied, starting');
  });

  it('keeps the last read error as the cause when it gives up', async () => {
    const clock = fakeClock();
    const down = new Error('connect ECONNREFUSED');
    const failure = await waitForMigrations({
      journal: JOURNAL,
      readApplied: answers(down),
      ...clock,
    }).catch((error: unknown) => error);

    expect((failure as Error).cause).toBe(down);
  });

  it('refuses at once, saying why, when the caller does not wait', async () => {
    const clock = fakeClock();
    const failure = await waitForMigrations({
      journal: JOURNAL,
      readApplied: answers(1_000),
      ...clock,
      ...jobWaitPolicy(true, false),
    }).catch((error: unknown) => error);

    expect(String(failure)).toContain(
      'the database has migration 0059_copy and this build needs 0060_drop; not waiting for it, because it was run by hand',
    );
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('starts at once without waiting when the database has the migration', async () => {
    const clock = fakeClock();
    await waitForMigrations({
      journal: JOURNAL,
      readApplied: answers(2_000),
      ...clock,
      ...jobWaitPolicy(true, false),
    });

    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('has nothing to wait for on an empty journal', async () => {
    const clock = fakeClock();
    const readApplied = answers(null);
    await waitForMigrations({ journal: [], readApplied, ...clock });

    expect(readApplied).not.toHaveBeenCalled();
  });
});

describe('jobWaitPolicy', () => {
  it('waits the full time for a cron, as the worker does', () => {
    expect(jobWaitPolicy(false, false)).toEqual({ timeoutMs: GATE_TIMEOUT_MS });
  });

  it('does not wait for a job somebody runs at a terminal', () => {
    expect(jobWaitPolicy(true, false)).toMatchObject({ timeoutMs: 0 });
    expect(jobWaitPolicy(true, false).notWaiting).toContain('run by hand');
  });

  it('does not wait again after a job earlier in the same run gave up', () => {
    // The template sync and the backlog snapshot are chained with `;`, so the
    // second would otherwise wait another fifteen minutes for the same answer.
    expect(jobWaitPolicy(false, true)).toMatchObject({
      timeoutMs: 0,
      notWaiting: 'a job earlier in this run already waited for it',
    });
  });
});

describe('readJournal', () => {
  it("reads this build's journal oldest first, ending at its newest migration", async () => {
    const file = path.join(process.cwd(), 'db/migrations/meta/_journal.json');
    const { entries } = JSON.parse(await readFile(file, 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const newest = entries.reduce((a, b) => (b.when > a.when ? b : a));

    const journal = await readJournal();

    expect(journal).toHaveLength(entries.length);
    expect(journal.at(-1)).toEqual({ tag: newest.tag, when: newest.when });
    expect(journal.map((entry) => entry.when)).toEqual(
      [...journal.map((entry) => entry.when)].sort((a, b) => a - b),
    );
  });
});
