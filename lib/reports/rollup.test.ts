import { describe, expect, it } from 'vitest';
import { daysUncounted, emptyBucket, reconciles, slicesFor, todayIn, type Slice } from './rollup';

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

describe('todayIn', () => {
  it('is the team’s date at the instant given, not the database’s or the server’s', () => {
    // 21:30 UTC on the 19th is 00:30 on the 20th in Cairo, at UTC+3 that week.
    expect(todayIn('Africa/Cairo', new Date('2026-10-19T21:30:00Z'))).toBe('2026-10-20');
    expect(todayIn('UTC', new Date('2026-10-19T21:30:00Z'))).toBe('2026-10-19');
  });

  it('moves its midnight with the clock when Cairo leaves summer time', () => {
    // From the 30th Cairo is UTC+2, so the same 21:30 UTC is still the day before.
    expect(todayIn('Africa/Cairo', new Date('2026-10-30T21:30:00Z'))).toBe('2026-10-30');
    expect(todayIn('Africa/Cairo', new Date('2026-10-30T22:30:00Z'))).toBe('2026-10-31');
  });
});

describe('daysUncounted', () => {
  const TODAY = { to: '2026-10-17' };

  it('is 0 once tonight’s run has reached yesterday, and 1 before it', () => {
    expect(daysUncounted(TODAY, '2026-10-16')).toBe(0);
    expect(daysUncounted(TODAY, '2026-10-15')).toBe(1);
  });

  it('counts the days a stalled rollup has not reached, across a month boundary', () => {
    expect(daysUncounted(TODAY, '2026-10-06')).toBe(10);
    expect(daysUncounted({ to: '2026-11-02' }, '2026-10-30')).toBe(2);
  });
});
