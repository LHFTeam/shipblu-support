import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { dayIn, emptyBucket, reconciles, slicesFor, type Slice } from './rollup';

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
 * Instants are built from Cairo's wall clock and converted by the zone database,
 * never by hand, so the offset each case relies on is the one Cairo really had.
 */
describe('dayIn', () => {
  const ZONE = 'Africa/Cairo';
  const cairo = (wallClock: string) => DateTime.fromISO(wallClock, { zone: ZONE }).toJSDate();

  it('lists the small hours of a summer night on their own day, which UTC does not', () => {
    const at = cairo('2026-10-14T02:59');
    expect(at.toISOString().slice(0, 10)).toBe('2026-10-13');
    expect(dayIn(at, ZONE)).toBe('2026-10-14');
  });

  it('lists the small hours of a winter night on their own day, at the other offset', () => {
    const at = cairo('2026-01-15T01:30');
    expect(at.toISOString().slice(0, 10)).toBe('2026-01-14');
    expect(dayIn(at, ZONE)).toBe('2026-01-15');
  });

  it('keeps the last minute of a day on that day', () => {
    expect(dayIn(cairo('2026-10-13T23:59'), ZONE)).toBe('2026-10-13');
  });

  it('follows the clocks across the night daylight saving ends', () => {
    // Cairo's clocks go back an hour at midnight between 29 and 30 October
    // 2026. 02:30 the night before is three hours ahead of UTC and 01:30 the
    // night after is two, so both are 23:30 the day before in UTC — one offset
    // hard-coded would get one of them wrong.
    expect(dayIn(cairo('2026-10-29T02:30'), ZONE)).toBe('2026-10-29');
    expect(dayIn(cairo('2026-10-30T01:30'), ZONE)).toBe('2026-10-30');
  });

  it('answers in the zone it is given, not the one the process runs in', () => {
    const at = cairo('2026-10-14T02:59');
    expect(dayIn(at, 'UTC')).toBe('2026-10-13');
  });
});
