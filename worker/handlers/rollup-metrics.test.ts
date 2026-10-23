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

  // 24 April 2026 opens at 01:00, when Cairo springs forward, so luxon's day
  // diff from it to the next midnight is 23 hours, not a day. Flooring that diff
  // left a range's first day out whenever it was that one, and `skipped` did not
  // count it.
  describe('a range that starts on the day Cairo springs forward', () => {
    const april = { today: '2026-10-23', earliest: '2026-04-24' };
    const threeDays = ['2026-04-26', '2026-04-25', '2026-04-24'];

    it('keeps that day when the range names it', () => {
      expect(planDays({ from: '2026-04-24', to: '2026-04-25' }, april, zone)).toEqual({
        days: ['2026-04-25', '2026-04-24'],
        skipped: 0,
      });
    });

    it('keeps it when `days` counts back to it', () => {
      expect(planDays({ days: 3, to: '2026-04-26' }, april, zone).days).toEqual(threeDays);
    });

    it('keeps it when the oldest ticket is on it', () => {
      expect(planDays({ to: '2026-04-26' }, april, zone).days).toEqual(threeDays);
    });

    it('keeps it when a rebuild names only `from`, as a repair of history does', () => {
      const plan = planDays({ from: '2026-04-24' }, april, zone);
      expect(plan.days).toHaveLength(182);
      expect(plan.days[0]).toBe('2026-10-22');
      expect(plan.days.at(-1)).toBe('2026-04-24');
    });

    it('keeps it when `days` counts back from yesterday onto it', () => {
      const after = { today: '2026-04-26', earliest: null };
      expect(planDays({ days: 2 }, after, zone).days).toEqual(['2026-04-25', '2026-04-24']);
    });

    it('counts it among the days the cap skipped', () => {
      // 2025-04-25 sprang forward at midnight too. From it through 2026-10-22 is
      // 546 days: the newest 400 are kept, and the warning must name the other
      // 146 rather than 145, or the operator re-running the rest misses one.
      const plan = planDays({ from: '2025-04-25' }, april, zone);
      expect(plan.days).toHaveLength(400);
      expect(plan.skipped).toBe(146);
    });

    it('counts the day the clocks go back as one day too', () => {
      const autumn = { today: '2026-11-05', earliest: null };
      expect(planDays({ from: '2026-10-29', to: '2026-10-30' }, autumn, zone).days).toEqual([
        '2026-10-30',
        '2026-10-29',
      ]);
    });
  });

  it("gives every two-day range in a decade of Cairo's calendar both of its days", () => {
    // Every changeover there has been or is scheduled, without naming one, so a
    // change to Egypt's rules moves the days rather than defeating the test. On
    // the floored diff this named the eight spring-forward Fridays, 2023 to 2030.
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
