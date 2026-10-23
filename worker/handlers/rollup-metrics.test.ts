import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { planDays } from './rollup-metrics';

/**
 * Which days a rollup run rebuilds.
 *
 * Every way of getting this wrong is quiet. One day short leaves a wrong row in
 * place; one day long writes today — still in progress — into the table the
 * reports page reads as complete. Neither looks like a failure from outside.
 */
describe('planDays', () => {
  const zone = 'Africa/Cairo';
  const bounds = { today: '2026-08-19', earliest: '2026-06-01' };

  it('recomputes yesterday and the two days behind it when unattended', () => {
    expect(planDays({}, bounds, zone).days).toEqual(['2026-08-18', '2026-08-17', '2026-08-16']);
  });

  it('takes a single named day as given', () => {
    expect(planDays({ day: '2026-07-04' }, bounds, zone)).toEqual({
      days: ['2026-07-04'],
      skipped: 0,
    });
  });

  it('walks an inclusive range, newest first', () => {
    expect(planDays({ from: '2026-08-15', to: '2026-08-17' }, bounds, zone).days).toEqual([
      '2026-08-17',
      '2026-08-16',
      '2026-08-15',
    ]);
  });

  it('never writes today, however the range asks for it', () => {
    // Today is partial. The dashboard already shows it live from the same code;
    // storing half a day would make the reports page read it as a whole one.
    for (const payload of [
      { from: '2026-08-17', to: '2026-08-19' },
      { from: '2026-08-17', to: '2027-01-01' },
      { days: 5 },
    ]) {
      expect(planDays(payload, bounds, zone).days).not.toContain('2026-08-19');
      expect(planDays(payload, bounds, zone).days[0]).toBe('2026-08-18');
    }
  });

  it('counts `days` back from yesterday, inclusive', () => {
    expect(planDays({ days: 3 }, bounds, zone).days).toEqual([
      '2026-08-18',
      '2026-08-17',
      '2026-08-16',
    ]);
    expect(planDays({ days: 1 }, bounds, zone).days).toEqual(['2026-08-18']);
  });

  it('rebuilds everything from the oldest ticket when no start is named', () => {
    const plan = planDays({ to: '2026-08-18' }, bounds, zone);
    expect(plan.days.at(-1)).toBe('2026-06-01');
    expect(plan.days[0]).toBe('2026-08-18');
    expect(plan.skipped).toBe(0);
  });

  it('falls back to the cron window when there is no data to bound a rebuild', () => {
    // A deployment with no tickets at all: "everything" is not the beginning of
    // time, it is nothing much.
    const plan = planDays({ to: '2026-08-18' }, { today: '2026-08-19', earliest: null }, zone);
    expect(plan.days).toEqual(['2026-08-18', '2026-08-17', '2026-08-16']);
  });

  it('caps an over-long range and reports what it skipped', () => {
    const plan = planDays({ from: '2020-01-01' }, bounds, zone);
    expect(plan.days).toHaveLength(400);
    expect(plan.skipped).toBeGreaterThan(0);
    // The most recent days are the ones kept — they are the ones being read.
    expect(plan.days[0]).toBe('2026-08-18');
  });

  it('returns nothing for a backwards or unparseable range', () => {
    expect(planDays({ from: '2026-08-18', to: '2026-08-01' }, bounds, zone).days).toEqual([]);
    expect(planDays({ from: 'not-a-date' }, bounds, zone).days).toEqual([]);
  });

  it('treats a range ending before any data as empty rather than as the default', () => {
    expect(planDays({ from: '2019-01-01', to: '2019-02-01' }, bounds, zone).days).toHaveLength(32);
  });
});

/**
 * Cairo springs forward at midnight on the last Friday of April, so that day has
 * no 00:00: it begins at 01:00 and is 23 hours long. A range sized on the
 * instants between its first and last day came up a day short whenever the
 * first was such a day, and said nothing about it (docs/PROJECT-STATE.md
 * §6.101). Starting a rebuild there is the natural way to correct history after
 * a day-boundary fix, so it lost exactly the day being corrected.
 */
describe('planDays across a daylight-saving change', () => {
  const zone = 'Africa/Cairo';

  // A missing midnight, not merely a 23-hour day: a spring-forward at 02:00 is
  // 23 hours too, and there the instants between two midnights are whole days.
  it('has no midnight on 24 April 2026, or nothing below tests the changeover', () => {
    expect(DateTime.fromISO('2026-04-24', { zone }).hour).toBe(1);
  });

  it("keeps a range's first day when that day springs forward", () => {
    expect(
      planDays(
        { from: '2026-04-24', to: '2026-04-25' },
        { today: '2026-10-23', earliest: null },
        zone,
      ),
    ).toEqual({ days: ['2026-04-25', '2026-04-24'], skipped: 0 });
  });

  it('rebuilds from a spring-forward day through yesterday', () => {
    const plan = planDays({ from: '2026-04-24' }, { today: '2026-10-23', earliest: null }, zone);
    expect(plan.days).toHaveLength(182);
    expect(plan.days[0]).toBe('2026-10-22');
    expect(plan.days.at(-1)).toBe('2026-04-24');
  });

  it('counts `days` back onto a spring-forward day', () => {
    expect(planDays({ days: 2 }, { today: '2026-04-26', earliest: null }, zone).days).toEqual([
      '2026-04-25',
      '2026-04-24',
    ]);
  });

  it('starts a full rebuild on the oldest day when that day springs forward', () => {
    expect(
      planDays({ to: '2026-04-26' }, { today: '2026-04-27', earliest: '2026-04-24' }, zone).days,
    ).toEqual(['2026-04-26', '2026-04-25', '2026-04-24']);
  });

  it('reports every day the cap skipped when the range starts on one', () => {
    // 2025-04-25 sprang forward at midnight too. From it through 2026-10-22 is
    // 546 days: the cap keeps the newest 400, and the warning must name the
    // other 146 rather than 145, or the operator re-runs and misses a day.
    const plan = planDays({ from: '2025-04-25' }, { today: '2026-10-23', earliest: null }, zone);
    expect(plan.days).toHaveLength(400);
    expect(plan.skipped).toBe(146);
  });

  it('keeps both days of a range over the fall-back day', () => {
    // Thursday 29 October 2026 runs to 24:00 and back to 23:00. Its midnight
    // exists, so this was always right; it stays right.
    expect(
      planDays(
        { from: '2026-10-29', to: '2026-10-30' },
        { today: '2026-11-01', earliest: null },
        zone,
      ).days,
    ).toEqual(['2026-10-30', '2026-10-29']);
  });

  it("gives every two-day range in a decade of Cairo's calendar both of its days", () => {
    // Every changeover there has been or is scheduled, without naming one, so
    // a change to Egypt's rules moves the days rather than defeating the test.
    const short: string[] = [];
    for (
      let day = DateTime.fromISO('2020-01-01', { zone });
      day.year < 2031;
      day = day.plus({ days: 1 })
    ) {
      const from = day.toISODate()!;
      const to = day.plus({ days: 1 }).toISODate()!;
      const plan = planDays({ from, to }, { today: '2031-01-02', earliest: null }, zone);
      if (plan.days.join() !== [to, from].join()) short.push(from);
    }
    expect(short).toEqual([]);
  });
});
