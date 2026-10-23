import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { cairo } from '@/lib/testing/time';
import { dateIn, dayWindow, emptyBucket, reconciles, slicesFor, type Slice } from './rollup';

/**
 * `metrics_daily` stores four slices per day — the totals, and then by group, by
 * agent and by channel — with null meaning "all" in each dimension. The reports
 * page reads its headline figures from the totals slice, so a ticket landing in
 * that slice twice inflates every number on the page.
 */
describe('slicesFor', () => {
  it('puts a fully dimensioned ticket in the totals and one row per dimension', () => {
    expect(slicesFor({ groupId: 'group-1', agentId: 'agent-1', channel: 'email' })).toEqual([
      { groupId: null, agentId: null, channel: null },
      { groupId: 'group-1', agentId: null, channel: null },
      { groupId: null, agentId: 'agent-1', channel: null },
      { groupId: null, agentId: null, channel: 'email' },
    ]);
  });

  it('counts an unassigned ticket in the totals exactly once', () => {
    // The regression this guards: an unassigned ticket's "by agent" slice is
    // itself all nulls, which is indistinguishable from the totals slice unless
    // the dimension is checked rather than the nulls.
    const slices = slicesFor({ groupId: 'group-1', agentId: null, channel: 'email' });

    const totals = slices.filter((slice) => !slice.groupId && !slice.agentId && !slice.channel);
    expect(totals).toHaveLength(1);
    expect(slices).toHaveLength(3);
  });

  it('counts a ticket with no group and no assignee in the totals exactly once', () => {
    expect(slicesFor({ groupId: null, agentId: null, channel: 'webchat' })).toEqual([
      { groupId: null, agentId: null, channel: null },
      { groupId: null, agentId: null, channel: 'webchat' },
    ]);
  });

  it('never emits a row keyed on a dimension the ticket does not have', () => {
    for (const slice of slicesFor({ groupId: null, agentId: 'agent-1', channel: null })) {
      expect(slice.groupId).toBeNull();
      expect(slice.channel).toBeNull();
    }
  });
});

/**
 * The invariant the double-counted totals slice broke: every countable fact
 * carries a channel, so the totals row must equal the sum of the channel rows.
 */
describe('reconciles', () => {
  const slice = (channel: string | null, created: number): Slice => ({
    groupId: null,
    agentId: null,
    channel,
    bucket: { ...emptyBucket(), ticketsCreated: created },
  });

  it('accepts a day whose totals equal the sum of its channel rows', () => {
    expect(reconciles([slice(null, 5), slice('email', 3), slice('whatsapp', 2)])).toBe(true);
  });

  it('rejects the inflated totals the old slicing produced', () => {
    // Production's 2026-08-18: four tickets with neither group nor assignee
    // counted three times each, one with an assignee counted twice — a totals
    // row of 14 over five real tickets.
    expect(reconciles([slice(null, 14), slice('email', 3), slice('whatsapp', 2)])).toBe(false);
  });

  it('accepts a day on which nothing happened', () => {
    expect(reconciles([])).toBe(true);
    expect(reconciles([slice(null, 0)])).toBe(true);
  });

  it('ignores the group and agent rows, which legitimately do not sum to the totals', () => {
    // An unassigned ticket is in the totals and in no "by agent" row at all, so
    // only the channel rows can be checked against the totals.
    const withAgent: Slice = {
      groupId: null,
      agentId: 'agent-1',
      channel: null,
      bucket: { ...emptyBucket(), ticketsCreated: 1 },
    };
    expect(reconciles([slice(null, 5), slice('email', 5), withAgent])).toBe(true);
  });

  it('checks the survey counts too, each step of the scale on its own', () => {
    const surveys = (channel: string | null, counts: Partial<Slice['bucket']>): Slice => ({
      groupId: null,
      agentId: null,
      channel,
      bucket: { ...emptyBucket(), ...counts },
    });
    const day = [
      surveys(null, { csatSentCount: 3, csatSkippedCount: 1, csatRating2: 1, csatRating5: 2 }),
      surveys('email', { csatSentCount: 2, csatRating5: 2 }),
      surveys('webchat', { csatSentCount: 1, csatSkippedCount: 1, csatRating2: 1 }),
    ];
    expect(reconciles(day)).toBe(true);

    // A survey counted in the totals and in no channel — what a survey with no
    // channel of its own would do without the ticket's to fall back on.
    for (const counts of [
      { csatSentCount: 4 },
      { csatSkippedCount: 2 },
      { csatRating2: 2 },
      { csatRating5: 1 },
    ]) {
      const [totals, ...rest] = day;
      expect(reconciles([surveys(null, { ...totals!.bucket, ...counts }), ...rest])).toBe(false);
    }
  });
});

/**
 * The day a row is listed under is the team's day. The bug this guards printed
 * `toISOString().slice(0, 10)`, the UTC date, so a message that reached Cairo
 * before 02:00 (03:00 under daylight saving) was listed on the day before.
 *
 * Every case below is one some wrong answer gets wrong: the UTC slice, a fixed
 * +02:00, a fixed +03:00, or a zone argument ignored for Cairo's. Cairo is
 * +02:00 in winter and +03:00 under daylight saving, and the two put an instant
 * on different days only from 21:00 to 22:00 UTC — the hour before the team's
 * midnight in winter and the hour after it in summer — so the cases that catch
 * a fixed offset sit there.
 */
describe('dateIn', () => {
  const ZONE = 'Africa/Cairo';

  it('lists the small hours on the day they fall on, which UTC does not', () => {
    // Before 03:00 under daylight saving, and before 02:00 without it, it is
    // still the day before in UTC.
    expect(dateIn(cairo('2026-10-14T02:59'), ZONE)).toBe('2026-10-14');
    expect(dateIn(cairo('2026-01-15T01:59'), ZONE)).toBe('2026-01-15');
  });

  it('takes the offset from the zone database, not one fixed for the year', () => {
    // Both are 21:30 UTC. Half past midnight under daylight saving is the day
    // before at +02:00, and half past eleven in winter is the day after at
    // +03:00.
    expect(dateIn(cairo('2026-10-14T00:30'), ZONE)).toBe('2026-10-14');
    expect(dateIn(cairo('2026-01-15T23:30'), ZONE)).toBe('2026-01-15');
  });

  it('follows the clocks across the night daylight saving ends', () => {
    // Cairo's clocks go back from midnight to 23:00 between 29 and 30 October
    // 2026, so 23:30 on the 29th happens twice; `cairo()` names the first, and
    // the second is an hour after it. Half past midnight that morning is still
    // +03:00, and the second 23:30 and the next night are +02:00, so every one
    // of these is 21:30 UTC and lands on the wrong day under one fixed offset.
    const secondPass = new Date(cairo('2026-10-29T23:30').getTime() + 60 * 60 * 1000);

    expect(dateIn(cairo('2026-10-29T00:30'), ZONE)).toBe('2026-10-29');
    expect(dateIn(secondPass, ZONE)).toBe('2026-10-29');
    expect(dateIn(cairo('2026-10-30T23:30'), ZONE)).toBe('2026-10-30');
  });

  it('answers in the zone it is given, not in Cairo whatever it is asked', () => {
    expect(dateIn(cairo('2026-10-14T02:59'), 'UTC')).toBe('2026-10-13');
  });

  it('refuses a zone it cannot read rather than answering nothing', () => {
    // The reporting zone is `business_hours.timezone`, checked only by the
    // hours form; a row edited in the database reaches here unchecked.
    expect(() => dateIn(cairo('2026-10-14T02:59'), 'Africa/Kairo')).toThrow(/Africa\/Kairo/);
  });
});

/**
 * Where every rollup cuts its day. A day that does not end where the next one
 * begins counts an hour twice or not at all, and nothing in the stored rows
 * shows which: the category rollup counted the first hour of 25 April 2026 on
 * the 24th as well, because Cairo springs forward at the midnight that opens
 * the 24th and a day added to its 01:00 start ran an hour into the 25th
 * (`docs/PROJECT-STATE.md` §6.101).
 */
describe('dayWindow', () => {
  const CAIRO = 'Africa/Cairo';

  it('opens the day Cairo springs forward at 01:00 and ends it at the next midnight', () => {
    expect(dayWindow('2026-04-24', CAIRO)).toEqual({
      start: cairo('2026-04-24T01:00'),
      end: cairo('2026-04-25T00:00'),
    });
  });

  it('holds all 25 hours of the day the clocks go back', () => {
    const window = dayWindow('2026-10-29', CAIRO)!;
    expect(window).toEqual({ start: cairo('2026-10-29T00:00'), end: cairo('2026-10-30T00:00') });
    expect(window.end.getTime() - window.start.getTime()).toBe(25 * 3_600_000);
  });

  it('ends every Cairo day where the next begins, from DST coming back to 2027', () => {
    const seams: string[] = [];
    for (
      let day = DateTime.fromISO('2023-01-01', { zone: 'utc' });
      day.year < 2028;
      day = day.plus({ days: 1 })
    ) {
      const end = dayWindow(day.toISODate()!, CAIRO)!.end;
      const next = dayWindow(day.plus({ days: 1 }).toISODate()!, CAIRO)!.start;
      if (end.getTime() !== next.getTime()) seams.push(day.toISODate()!);
    }
    expect(seams).toEqual([]);
  });

  it('leaves no hour between two days where luxon reads a bare date an hour late', () => {
    // Samoa sprang forward on 24 September 2011 and crossed the date line that
    // December. Luxon resolves a wall-clock time from an offset it guesses for
    // the zone once and caches, and any guess since then (+13 or +14) is far
    // from 2011's, so a bare 25 September lands at 01:00 rather than at its
    // midnight; only the start's own `startOf('day')` puts it back.
    const zone = 'Pacific/Apia';
    expect(dayWindow('2011-09-25', zone)!.start).toEqual(dayWindow('2011-09-24', zone)!.end);
  });

  it('answers null for a day that does not parse', () => {
    expect(dayWindow('not-a-date', CAIRO)).toBeNull();
  });
});
