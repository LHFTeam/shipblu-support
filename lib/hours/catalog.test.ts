import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The memo, not the query. No database: `db` is stubbed so each `select()` is
 * counted, which is the only thing these tests are about — how many times three
 * queries reach the pool for a dozen rows that change when an admin saves a
 * schedule.
 *
 * Worth testing rather than eyeballing because the SLA sweep calls
 * `loadHoursCatalog()` four times per run, every five minutes, and a memo that
 * silently stopped memoising would look exactly like the code did before
 * (§62 and `plans/web-freeze-2026-09-08.md`).
 */
const selects = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/db/client', () => ({
  db: {
    select: () => {
      selects.count += 1;
      const rows: unknown[] = [];
      // Enough of the builder to satisfy both shapes the loader uses: a bare
      // `.from()` and a `.from().where()`.
      const result = Object.assign(Promise.resolve(rows), {
        from: () => result,
        where: () => result,
      });
      return result;
    },
  },
}));

const { forgetHoursCatalog, loadHoursCatalog } = await import('./catalog');

beforeEach(() => {
  selects.count = 0;
  forgetHoursCatalog();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadHoursCatalog', () => {
  it('issues its three queries once, not once per caller', async () => {
    await loadHoursCatalog();
    await loadHoursCatalog();
    await loadHoursCatalog();
    await loadHoursCatalog();

    // Four callers is not hypothetical: it is one SLA sweep run.
    expect(selects.count).toBe(3);
  });

  it('re-reads once the window has passed', async () => {
    await loadHoursCatalog();
    expect(selects.count).toBe(3);

    // A due date is computed from this, so the window is deliberately short.
    vi.advanceTimersByTime(30_001);
    await loadHoursCatalog();

    expect(selects.count).toBe(6);
  });

  it('still serves the memo one millisecond inside the window', async () => {
    await loadHoursCatalog();
    vi.advanceTimersByTime(29_999);
    await loadHoursCatalog();

    expect(selects.count).toBe(3);
  });

  it('re-reads immediately after a schedule is saved', async () => {
    await loadHoursCatalog();
    expect(selects.count).toBe(3);

    // What `admin/hours/actions.ts` calls beside every `refresh('/admin/hours')`.
    // Without it an admin who edits a schedule watches the old one apply for
    // another thirty seconds, on a page whose whole purpose is that schedule.
    forgetHoursCatalog();
    await loadHoursCatalog();

    expect(selects.count).toBe(6);
  });

  it('does not cache a failure', async () => {
    // The memo is assigned after the await, so a throw leaves it null and the
    // next caller tries again rather than inheriting a broken read for thirty
    // seconds. Asserted because the alternative — memoising the promise — is
    // the obvious "improvement" and would cache the rejection.
    selects.count = 0;
    const failing = vi.fn(() => {
      throw new Error('database unreachable');
    });

    const client = (await import('@/db/client')) as unknown as { db: { select: () => unknown } };
    const original = client.db.select;
    client.db.select = failing as unknown as typeof original;

    await expect(loadHoursCatalog()).rejects.toThrow('database unreachable');

    client.db.select = original;
    await loadHoursCatalog();

    expect(selects.count).toBe(3);
  });
});
