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
