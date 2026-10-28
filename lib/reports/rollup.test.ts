import { describe, expect, it } from 'vitest';
import { cairo } from '@/lib/testing/time';
import {
  dateIn,
  emptyBucket,
  reconcileFailure,
  reconciles,
  sliceAccumulator,
  slicesFor,
  totalsOf,
  type Dimensions,
  type Slice,
} from './rollup';

const ALL: Dimensions = { groupId: null, agentId: null, channel: null, categoryId: null };

/** How many dimensions a slice names: none for the totals, one for any other. */
const named = ({ groupId, agentId, channel, categoryId }: Dimensions) =>
  [groupId, agentId, channel, categoryId].filter((value) => value !== null).length;

/** The slice naming exactly these dimensions, and every other one null. */
const sliceOf = (slices: Slice[], dims: Partial<Dimensions>) => {
  const want = { ...ALL, ...dims };
  return slices.find(
    (slice) =>
      slice.groupId === want.groupId &&
      slice.agentId === want.agentId &&
      slice.channel === want.channel &&
      slice.categoryId === want.categoryId,
  );
};

/**
 * `metrics_daily` stores five slices per day — the totals, and then by group, by
 * agent, by channel and by category — with null meaning "all" in each
 * dimension. The reports page reads its headline figures from the totals slice,
 * so a ticket landing in that slice twice inflates every number on the page.
 */
describe('slicesFor', () => {
  it('puts a fully dimensioned ticket in the totals and one row per dimension', () => {
    expect(
      slicesFor({ groupId: 'group-1', agentId: 'agent-1', channel: 'email', categoryId: 'sales' }),
    ).toEqual([
      { groupId: null, agentId: null, channel: null, categoryId: null },
      { groupId: 'group-1', agentId: null, channel: null, categoryId: null },
      { groupId: null, agentId: 'agent-1', channel: null, categoryId: null },
      { groupId: null, agentId: null, channel: 'email', categoryId: null },
      { groupId: null, agentId: null, channel: null, categoryId: 'sales' },
    ]);
  });

  it('counts an unassigned ticket in the totals exactly once', () => {
    // The regression this guards: an unassigned ticket's "by agent" slice is
    // itself all nulls, which is indistinguishable from the totals slice unless
    // the dimension is checked rather than the nulls.
    const slices = slicesFor({ ...ALL, groupId: 'group-1', channel: 'email' });

    expect(slices.filter((slice) => named(slice) === 0)).toHaveLength(1);
    expect(slices).toHaveLength(3);
  });

  it('counts a ticket with no group and no assignee in the totals exactly once', () => {
    expect(slicesFor({ ...ALL, channel: 'webchat' })).toEqual([
      { groupId: null, agentId: null, channel: null, categoryId: null },
      { groupId: null, agentId: null, channel: 'webchat', categoryId: null },
    ]);
  });

  it('files a ticket nothing has categorised under no category, not under a null one', () => {
    // The same regression one dimension on: a category slice for "none" would
    // be the totals slice's twin, and every reader would add it to the totals.
    const slices = slicesFor({
      groupId: 'group-1',
      agentId: 'agent-1',
      channel: 'email',
      categoryId: null,
    });

    expect(slices).toHaveLength(4);
    expect(slices.every((slice) => slice.categoryId === null)).toBe(true);
    expect(slices.filter((slice) => named(slice) === 0)).toHaveLength(1);
  });

  it('never emits a row keyed on a dimension the ticket does not have', () => {
    for (const slice of slicesFor({ ...ALL, agentId: 'agent-1' })) {
      expect(slice.groupId).toBeNull();
      expect(slice.channel).toBeNull();
      expect(slice.categoryId).toBeNull();
    }
  });

  it('never emits a row naming two dimensions, which `metrics_daily_one_dimension` refuses', () => {
    const slices = slicesFor({
      groupId: 'group-1',
      agentId: 'agent-1',
      channel: 'email',
      categoryId: 'sales',
    });

    expect(slices.map(named)).toEqual([0, 1, 1, 1, 1]);
  });
});

/**
 * The accumulator `computeDay` files every fact through. What it hands back
 * must be what went in: a category slice read back without its category is a
 * second totals row, which every reader sums.
 */
describe('sliceAccumulator', () => {
  const ticket = (categoryId: string | null): Dimensions => ({
    groupId: 'group-1',
    agentId: 'agent-1',
    channel: 'email',
    categoryId,
  });
  const created = (bucket: Slice['bucket']) => {
    bucket.ticketsCreated += 1;
  };

  it('keeps every dimension of every slice it was handed', () => {
    const day = sliceAccumulator();
    day.add(ticket('sales'), created);
    day.add(ticket('sales'), created);
    day.add(ticket('customer_support'), created);
    day.add(ticket(null), created);

    const slices = day.slices();
    const tally = (dims: Partial<Dimensions>) => sliceOf(slices, dims)?.bucket.ticketsCreated;

    expect(slices).toHaveLength(6);
    expect(slices.filter((slice) => named(slice) === 0)).toHaveLength(1);
    expect(tally({})).toBe(4);
    expect(tally({ groupId: 'group-1' })).toBe(4);
    expect(tally({ agentId: 'agent-1' })).toBe(4);
    expect(tally({ channel: 'email' })).toBe(4);
    expect(tally({ categoryId: 'sales' })).toBe(2);
    expect(tally({ categoryId: 'customer_support' })).toBe(1);
    expect(reconciles(slices)).toBe(true);
  });
});

/**
 * The invariant the double-counted totals slice broke: every countable fact
 * carries a channel, so the totals row must equal the sum of the channel rows.
 * And the two the category brought: a day has one totals row, and its category
 * rows never sum past it, since a ticket has one category or none.
 */
describe('reconciles', () => {
  const slice = (channel: string | null, created: number): Slice => ({
    ...ALL,
    channel,
    bucket: { ...emptyBucket(), ticketsCreated: created },
  });
  const category = (categoryId: string, counts: Partial<Slice['bucket']>): Slice => ({
    ...ALL,
    categoryId,
    bucket: { ...emptyBucket(), ...counts },
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
      ...ALL,
      agentId: 'agent-1',
      bucket: { ...emptyBucket(), ticketsCreated: 1 },
    };
    expect(reconciles([slice(null, 5), slice('email', 5), withAgent])).toBe(true);
  });

  it('checks the survey counts too, each step of the scale on its own', () => {
    const surveys = (channel: string | null, counts: Partial<Slice['bucket']>): Slice => ({
      ...ALL,
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

  it('leaves the category rows out of the channel sum, as the group and agent rows are', () => {
    // Five tickets, three of them filed: the category rows sum to three, the
    // channels to five, and the day agrees with itself.
    expect(
      reconciles([
        slice(null, 5),
        slice('email', 5),
        category('sales', { ticketsCreated: 2 }),
        category('customer_support', { ticketsCreated: 1 }),
      ]),
    ).toBe(true);
  });

  it('refuses a second totals row, which `totalsOf` would never compare with anything', () => {
    // What a round trip that dropped the category hands back: the category's
    // figures as a second all-null slice, after the real totals.
    const day = [slice(null, 5), slice('email', 5), slice(null, 2)];

    expect(totalsOf(day).ticketsCreated).toBe(5);
    expect(reconciles(day)).toBe(false);
    expect(reconcileFailure(day)).toBe('each other: 2 slices name no dimension');
  });

  it('refuses category rows that sum past the totals in any column', () => {
    // One ticket in two categories — a ticket has one or none.
    const twice = [
      slice(null, 1),
      slice('email', 1),
      category('sales', { ticketsCreated: 1 }),
      category('customer_support', { ticketsCreated: 1 }),
    ];
    expect(reconciles(twice)).toBe(false);
    expect(reconcileFailure(twice)).toBe(
      'the category slices, which sum past them in ticketsCreated',
    );

    // A column the channel sum does not check, past the totals on its own.
    const seconds = { firstResponseCount: 1, firstResponseSecondsSum: 60 };
    const day = [
      { ...slice(null, 1), bucket: { ...emptyBucket(), ticketsCreated: 1, ...seconds } },
      { ...slice('email', 1), bucket: { ...emptyBucket(), ticketsCreated: 1, ...seconds } },
    ];
    expect(reconciles([...day, category('sales', { firstResponseSecondsSum: 60 })])).toBe(true);
    expect(reconcileFailure([...day, category('sales', { firstResponseSecondsSum: 61 })])).toBe(
      'the category slices, which sum past them in firstResponseSecondsSum',
    );
  });

  it('reads the totals off the slice naming no dimension, not one that names only a category', () => {
    // A category slice has no group, agent or channel either, so a totals
    // test that asked only those three took whichever came first.
    const day = [category('sales', { ticketsCreated: 2 }), slice(null, 5), slice('email', 5)];

    expect(totalsOf(day).ticketsCreated).toBe(5);
    expect(reconciles(day)).toBe(true);
  });

  it('names the channel sum when that is what a day broke', () => {
    expect(reconcileFailure([slice(null, 14), slice('email', 3), slice('whatsapp', 2)])).toBe(
      'the sum of the channel slices',
    );
    expect(reconcileFailure([slice(null, 5), slice('email', 5)])).toBeNull();
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
