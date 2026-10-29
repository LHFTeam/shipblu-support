import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  csatSurveys,
  groups,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { setConversationCategory } from '@/lib/categories/write';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import {
  computeDay,
  emptyBucket,
  reconcileFailure,
  reportingContext,
  totalsOf,
  type Bucket,
  type Slice,
} from './rollup';

/**
 * The survey half of `computeDay`, against real Postgres, on fixtures whose
 * distribution is known: each survey counts on the day of each of its own
 * timestamps (sent, skipped, answered), in the team's zone, on the channel it
 * was asked on, and the day's slices still add up.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();

type Channel = (typeof conversations.$inferInsert)['channel'];

async function ticket(channel: Channel): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [resolved] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Resolved'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: resolved!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

/**
 * The week the report is checked against. Each row says which day it counts
 * on and why; the day under test is 13 October.
 */
async function week() {
  const [ahmed, mona] = await db
    .insert(agents)
    .values([
      { name: 'Ahmed', email: 'ahmed@shipblu.test', role: 'agent' },
      { name: 'Mona', email: 'mona@shipblu.test', role: 'agent' },
    ])
    .returning({ id: agents.id });
  const [deliveries] = await db
    .insert(groups)
    .values({ name: 'Deliveries' })
    .returning({ id: groups.id });

  const survey = async (
    channel: Channel,
    row: Partial<typeof csatSurveys.$inferInsert>,
  ): Promise<void> => {
    await db.insert(csatSurveys).values({ conversationId: await ticket(channel), ...row });
  };

  // Sent and answered on the 13th, a five, Ahmed in Deliveries.
  await survey('email', {
    status: 'answered',
    channel: 'email',
    agentId: ahmed!.id,
    groupId: deliveries!.id,
    sentAt: at('2026-10-13T10:00'),
    createdAt: at('2026-10-13T10:00'),
    respondedAt: at('2026-10-13T15:00'),
    rating: 5,
  });
  // Sent half an hour before Cairo's midnight on the 12th, answered half an
  // hour after it: sent on the 12th, a two on the 13th.
  await survey('webchat', {
    status: 'answered',
    channel: 'webchat',
    agentId: mona!.id,
    sentAt: at('2026-10-12T23:30'),
    createdAt: at('2026-10-12T23:30'),
    respondedAt: at('2026-10-13T00:30'),
    rating: 2,
  });
  // A skip on the 13th.
  await survey('facebook', {
    status: 'skipped',
    skipReason: 'window_closed',
    channel: 'facebook',
    createdAt: at('2026-10-13T09:00'),
  });
  // Sent on the 13th and superseded since: it was sent all the same.
  await survey('email', {
    status: 'expired',
    channel: 'email',
    agentId: ahmed!.id,
    sentAt: at('2026-10-13T11:00'),
    createdAt: at('2026-10-13T11:00'),
  });
  // Asked on Instagram on a ticket merged into an email one since: the one,
  // on Instagram, counts where it was asked.
  await survey('email', {
    status: 'answered',
    channel: 'instagram',
    agentId: ahmed!.id,
    sentAt: at('2026-10-13T12:00'),
    createdAt: at('2026-10-13T12:00'),
    respondedAt: at('2026-10-13T13:00'),
    rating: 1,
  });
  // The one row written before surveys had a channel: the ticket's stands in.
  await survey('webchat', {
    status: 'answered',
    channel: null,
    sentAt: at('2026-10-13T08:00'),
    createdAt: at('2026-10-13T08:00'),
    respondedAt: at('2026-10-13T09:00'),
    rating: 4,
  });
  // The customer bot's: not the team's conversation, so on no day at all.
  await survey('whatsapp_bot', {
    status: 'skipped',
    skipReason: 'read_only_channel',
    channel: 'whatsapp_bot',
    createdAt: at('2026-10-13T10:00'),
  });
  // Sent on the 13th, answered ten minutes into the 14th: a three on the 14th.
  await survey('email', {
    status: 'answered',
    channel: 'email',
    sentAt: at('2026-10-13T20:00'),
    createdAt: at('2026-10-13T20:00'),
    respondedAt: at('2026-10-14T00:10'),
    rating: 3,
  });
  // A skip on the 12th.
  await survey('email', {
    status: 'skipped',
    skipReason: 'reopened',
    channel: 'email',
    createdAt: at('2026-10-12T22:00'),
  });

  return { ahmed: ahmed!.id, deliveries: deliveries!.id };
}

const SURVEY_COLUMNS = [
  'csatSentCount',
  'csatSkippedCount',
  'csatRating1',
  'csatRating2',
  'csatRating3',
  'csatRating4',
  'csatRating5',
  'csatResponseCount',
  'csatRatingSum',
] as const;

/** The survey columns of one slice, for comparing against what the fixtures say. */
function surveyCounts(slice: Slice | undefined) {
  if (!slice) return undefined;
  return Object.fromEntries(SURVEY_COLUMNS.map((column) => [column, slice.bucket[column]]));
}

const counts = (given: Partial<Record<(typeof SURVEY_COLUMNS)[number], number>>) =>
  Object.fromEntries(SURVEY_COLUMNS.map((column) => [column, given[column] ?? 0]));

const channel = (slices: Slice[], name: string) =>
  slices.find((slice) => slice.channel === name && !slice.groupId && !slice.agentId);

describe('computeDay, for surveys', () => {
  it('counts each survey on the day of each of its own timestamps', async () => {
    await week();
    const context = await reportingContext();
    expect(context.zone).toBe(ZONE);

    const thirteenth = await computeDay('2026-10-13', context);
    expect(surveyCounts({ ...thirteenth[0]!, bucket: totalsOf(thirteenth) })).toEqual(
      counts({
        // The five, the expired one, the Instagram one, the channel-less one,
        // and the one answered on the 14th.
        csatSentCount: 5,
        csatSkippedCount: 1,
        csatRating1: 1,
        csatRating2: 1,
        csatRating4: 1,
        csatRating5: 1,
        csatResponseCount: 4,
        csatRatingSum: 12,
      }),
    );
    expect(reconcileFailure(thirteenth)).toBeNull();

    const twelfth = await computeDay('2026-10-12', context);
    expect(surveyCounts({ ...twelfth[0]!, bucket: totalsOf(twelfth) })).toEqual(
      counts({ csatSentCount: 1, csatSkippedCount: 1 }),
    );

    const fourteenth = await computeDay('2026-10-14', context);
    expect(surveyCounts({ ...fourteenth[0]!, bucket: totalsOf(fourteenth) })).toEqual(
      counts({ csatRating3: 1, csatResponseCount: 1, csatRatingSum: 3 }),
    );
  });

  it('files each one under the channel it was asked on, and its own agent and group', async () => {
    const { ahmed, deliveries } = await week();
    const slices = await computeDay('2026-10-13', await reportingContext());

    expect(surveyCounts(channel(slices, 'email'))).toEqual(
      counts({ csatSentCount: 3, csatRating5: 1, csatResponseCount: 1, csatRatingSum: 5 }),
    );
    // The merged ticket's survey is Instagram's, not email's.
    expect(surveyCounts(channel(slices, 'instagram'))).toEqual(
      counts({ csatSentCount: 1, csatRating1: 1, csatResponseCount: 1, csatRatingSum: 1 }),
    );
    // The channel-less row on its ticket's web chat, beside the two from the 12th.
    expect(surveyCounts(channel(slices, 'webchat'))).toEqual(
      counts({
        csatSentCount: 1,
        csatRating2: 1,
        csatRating4: 1,
        csatResponseCount: 2,
        csatRatingSum: 6,
      }),
    );
    expect(surveyCounts(channel(slices, 'facebook'))).toEqual(counts({ csatSkippedCount: 1 }));
    // The bot's skip is on no channel and in no total.
    expect(channel(slices, 'whatsapp_bot')).toBeUndefined();

    expect(surveyCounts(slices.find((slice) => slice.agentId === ahmed))).toEqual(
      counts({
        csatSentCount: 3,
        csatRating1: 1,
        csatRating5: 1,
        csatResponseCount: 2,
        csatRatingSum: 6,
      }),
    );
    expect(surveyCounts(slices.find((slice) => slice.groupId === deliveries))).toEqual(
      counts({ csatSentCount: 1, csatRating5: 1, csatResponseCount: 1, csatRatingSum: 5 }),
    );
  });

  it('leaves out the surveys of a ticket since deleted or marked spam, as its resolution is', async () => {
    for (const change of [
      { deletedAt: at('2026-10-15T09:00') },
      { isSpam: true },
    ] satisfies Partial<typeof conversations.$inferInsert>[]) {
      const conversationId = await ticket('email');
      await db.insert(csatSurveys).values({
        conversationId,
        status: 'answered',
        channel: 'email',
        sentAt: at('2026-10-13T10:00'),
        respondedAt: at('2026-10-13T11:00'),
        rating: 1,
      });
      await db.update(conversations).set(change).where(eq(conversations.id, conversationId));
    }
    const slices = await computeDay('2026-10-13', await reportingContext());
    expect(surveyCounts({ ...slices[0]!, bucket: totalsOf(slices) })).toEqual(counts({}));
  });

  it('leaves out a rating off the scale everywhere, so the average and the bars agree', async () => {
    await db.insert(csatSurveys).values({
      conversationId: await ticket('email'),
      status: 'answered',
      channel: 'email',
      sentAt: at('2026-10-13T10:00'),
      respondedAt: at('2026-10-13T11:00'),
      rating: 7,
    });
    const slices = await computeDay('2026-10-13', await reportingContext());
    expect(surveyCounts({ ...slices[0]!, bucket: totalsOf(slices) })).toEqual(
      counts({ csatSentCount: 1 }),
    );
  });
});

describe('computeDay, for a ticket on a WhatsApp number with an owner', () => {
  const TICKET_COLUMNS = [
    'ticketsCreated',
    'ticketsResolved',
    'ticketsReopened',
    'firstResponseCount',
    'slaFirstResponseMet',
    'slaFirstResponseBreached',
    'resolutionCount',
    'slaResolutionMet',
    'slaResolutionBreached',
  ] as const;

  const ticketCounts = (slice: Slice | undefined) =>
    slice && Object.fromEntries(TICKET_COLUMNS.map((column) => [column, slice.bucket[column]]));

  const expected = (given: Partial<Record<(typeof TICKET_COLUMNS)[number], number>>) =>
    Object.fromEntries(TICKET_COLUMNS.map((column) => [column, given[column] ?? 0]));

  // The requirement in one fixture: the number's owner answers for its
  // tickets' SLA whoever a supervisor gives the work to, and a ticket on a
  // team number is filed exactly as before owners existed.
  it('files every ticket figure under the owner whoever holds it, and an unowned one under its holder', async () => {
    const [nayera, bob] = await db
      .insert(agents)
      .values([
        { name: 'Nayera', email: 'nayera@shipblu.test', role: 'agent' },
        { name: 'Bob', email: 'bob@shipblu.test', role: 'agent' },
      ])
      .returning({ id: agents.id });
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    const [resolved] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    const base = {
      channel: 'whatsapp' as const,
      statusId: resolved!.id,
      requesterContactId: contact!.id,
    };

    // Nayera's, reassigned to Bob: answered inside its target, resolved past
    // its, reopened once — all on the 13th.
    const [reassigned] = await db
      .insert(conversations)
      .values({
        ...base,
        accountableAgentId: nayera!.id,
        assigneeAgentId: bob!.id,
        createdAt: at('2026-10-13T09:00'),
        firstRespondedAt: at('2026-10-13T09:10'),
        firstResponseDueAt: at('2026-10-13T10:00'),
        resolvedAt: at('2026-10-13T15:00'),
        resolutionDueAt: at('2026-10-13T12:00'),
      })
      .returning({ id: conversations.id });
    await db.insert(conversationEvents).values({
      conversationId: reassigned!.id,
      type: 'reopened',
      createdAt: at('2026-10-13T13:00'),
    });
    // Nayera's and held by nobody: still hers.
    await db.insert(conversations).values({
      ...base,
      accountableAgentId: nayera!.id,
      createdAt: at('2026-10-13T11:00'),
    });
    // A team number's, held by Bob: answered past its target, and his.
    await db.insert(conversations).values({
      ...base,
      assigneeAgentId: bob!.id,
      createdAt: at('2026-10-13T09:30'),
      firstRespondedAt: at('2026-10-13T11:00'),
      firstResponseDueAt: at('2026-10-13T10:00'),
    });

    const slices = await computeDay('2026-10-13', await reportingContext());
    const agent = (id: string) => slices.find((slice) => slice.agentId === id);

    expect(ticketCounts(agent(nayera!.id))).toEqual(
      expected({
        ticketsCreated: 2,
        ticketsResolved: 1,
        ticketsReopened: 1,
        firstResponseCount: 1,
        slaFirstResponseMet: 1,
        resolutionCount: 1,
        slaResolutionBreached: 1,
      }),
    );
    expect(ticketCounts(agent(bob!.id))).toEqual(
      expected({ ticketsCreated: 1, firstResponseCount: 1, slaFirstResponseBreached: 1 }),
    );
    // Moved between agents, never duplicated or lost: the totals are the sum.
    expect(ticketCounts({ ...slices[0]!, bucket: totalsOf(slices) })).toEqual(
      expected({
        ticketsCreated: 3,
        ticketsResolved: 1,
        ticketsReopened: 1,
        firstResponseCount: 2,
        slaFirstResponseMet: 1,
        slaFirstResponseBreached: 1,
        resolutionCount: 1,
        slaResolutionBreached: 1,
      }),
    );
    expect(reconcileFailure(slices)).toBeNull();
  });

  // The nightly run rebuilds three days from current state. A handover on the
  // 14th moves the column on a ticket still open, and rebuilding the 13th from
  // the column alone filed Monday's late answer — made under Nayera — against
  // Ali, who did not hold the phone yet. Each figure is filed as of its own
  // instant, from the event the handover left.
  it("keeps a day's figures with whoever answered for them then, after a handover", async () => {
    const [nayera, ali] = await db
      .insert(agents)
      .values([
        { name: 'Nayera', email: 'nayera@shipblu.test', role: 'agent' },
        { name: 'Ali', email: 'ali@shipblu.test', role: 'agent' },
      ])
      .returning({ id: agents.id });
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));

    // Answered late on the 13th under Nayera, still open, handed to Ali on the
    // 14th — so the column now names him.
    const [late] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        statusId: open!.id,
        requesterContactId: contact!.id,
        accountableAgentId: ali!.id,
        assigneeAgentId: ali!.id,
        createdAt: at('2026-10-13T09:00'),
        firstRespondedAt: at('2026-10-13T11:00'),
        firstResponseDueAt: at('2026-10-13T10:00'),
      })
      .returning({ id: conversations.id });
    await db.insert(conversationEvents).values({
      conversationId: late!.id,
      type: 'accountable_changed',
      createdAt: at('2026-10-14T08:00'),
      data: { from: nayera!.id, to: ali!.id, channelId: null, reason: 'number_handover' },
    });

    const thirteenth = await computeDay('2026-10-13', await reportingContext());
    const agent = (id: string) => thirteenth.find((slice) => slice.agentId === id);

    expect(ticketCounts(agent(nayera!.id))).toEqual(
      expected({ ticketsCreated: 1, firstResponseCount: 1, slaFirstResponseBreached: 1 }),
    );
    expect(agent(ali!.id)).toBeUndefined();
    expect(reconcileFailure(thirteenth)).toBeNull();
  });
});

/**
 * The fifth slice. A category is single-valued, so its slices are a partition
 * of the categorised tickets: each figure of a filed ticket counts in the
 * totals and in its one category's slice, an unfiled ticket's in the totals
 * alone, and "no category" is the difference. Filed by the ticket's category
 * as it stands when the day is computed, every figure alike (`rollup.ts`'s
 * header says why), so a relabel moves a day's figures when the day is
 * computed again.
 */
describe('computeDay, by category', () => {
  const COLUMNS = Object.keys(emptyBucket()) as (keyof Bucket)[];

  async function categoryId(key: string): Promise<string> {
    const [row] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, key));
    return row!.id;
  }

  async function resolvedStatus(): Promise<string> {
    const [row] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    return row!.id;
  }

  type Fixture = Partial<typeof conversations.$inferInsert> & { channel: Channel };

  async function file(row: Fixture): Promise<string> {
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    const [ticket] = await db
      .insert(conversations)
      .values({ statusId: await resolvedStatus(), requesterContactId: contact!.id, ...row })
      .returning({ id: conversations.id });
    return ticket!.id;
  }

  /**
   * The 13th: two sales tickets, one customer-support one and one nothing has
   * filed, between them created, answered (inside a target and past one),
   * resolved, reopened and surveyed on the day.
   */
  async function thirteenth() {
    const sales = await categoryId('sales');
    const support = await categoryId('customer_support');
    const [deliveries] = await db
      .insert(groups)
      .values({ name: 'Deliveries' })
      .returning({ id: groups.id });

    // Sales, by email: answered inside its target, resolved past its,
    // reopened in between, and surveyed — a four.
    const salesEmail = await file({
      channel: 'email',
      categoryId: sales,
      groupId: deliveries!.id,
      createdAt: cairo('2026-10-13T09:00'),
      firstRespondedAt: cairo('2026-10-13T09:20'),
      firstResponseDueAt: cairo('2026-10-13T10:00'),
      resolvedAt: cairo('2026-10-13T15:00'),
      resolutionDueAt: cairo('2026-10-13T12:00'),
    });
    await db.insert(conversationEvents).values({
      conversationId: salesEmail,
      type: 'reopened',
      createdAt: cairo('2026-10-13T13:00'),
    });
    await db.insert(csatSurveys).values({
      conversationId: salesEmail,
      status: 'answered',
      channel: 'email',
      groupId: deliveries!.id,
      sentAt: cairo('2026-10-13T15:30'),
      createdAt: cairo('2026-10-13T15:30'),
      respondedAt: cairo('2026-10-13T16:00'),
      rating: 4,
    });
    // Sales, on WhatsApp: answered past its target, still open.
    await file({
      channel: 'whatsapp',
      categoryId: sales,
      createdAt: cairo('2026-10-13T10:00'),
      firstRespondedAt: cairo('2026-10-13T11:30'),
      firstResponseDueAt: cairo('2026-10-13T11:00'),
    });
    // Customer support, by web chat: resolved on the day with no target.
    await file({
      channel: 'webchat',
      categoryId: support,
      createdAt: cairo('2026-10-13T11:00'),
      resolvedAt: cairo('2026-10-13T16:00'),
    });
    // Nothing has filed this one: answered, reopened, resolved, and its
    // survey skipped — in the totals and in no category.
    const unfiled = await file({
      channel: 'email',
      createdAt: cairo('2026-10-13T12:00'),
      firstRespondedAt: cairo('2026-10-13T12:10'),
      firstResponseDueAt: cairo('2026-10-13T13:00'),
      resolvedAt: cairo('2026-10-13T14:00'),
    });
    await db.insert(conversationEvents).values({
      conversationId: unfiled,
      type: 'reopened',
      createdAt: cairo('2026-10-13T13:30'),
    });
    await db.insert(csatSurveys).values({
      conversationId: unfiled,
      status: 'skipped',
      skipReason: 'reopened',
      channel: 'email',
      createdAt: cairo('2026-10-13T14:30'),
    });

    return { sales, support, salesEmail };
  }

  const byCategory = (slices: Slice[], id: string) =>
    slices.find((slice) => slice.categoryId === id);

  /** The named columns of a bucket, every other one zero. */
  const figures = (given: Partial<Bucket>): Bucket => ({ ...emptyBucket(), ...given });

  /** A bucket's figures, the seconds sums aside: those are measured in working time. */
  const counted = (bucket: Bucket | undefined) =>
    bucket && { ...bucket, firstResponseSecondsSum: 0, resolutionSecondsSum: 0 };

  it("files each figure under its ticket's category, and an unfiled ticket under none", async () => {
    const { sales, support } = await thirteenth();
    const slices = await computeDay('2026-10-13', await reportingContext());

    expect(counted(byCategory(slices, sales)?.bucket)).toEqual(
      figures({
        ticketsCreated: 2,
        firstResponseCount: 2,
        slaFirstResponseMet: 1,
        slaFirstResponseBreached: 1,
        ticketsResolved: 1,
        resolutionCount: 1,
        slaResolutionBreached: 1,
        ticketsReopened: 1,
        csatSentCount: 1,
        csatResponseCount: 1,
        csatRating4: 1,
        csatRatingSum: 4,
      }),
    );
    expect(counted(byCategory(slices, support)?.bucket)).toEqual(
      figures({ ticketsCreated: 1, ticketsResolved: 1, resolutionCount: 1 }),
    );

    // Two category slices and no third for "none", each naming its category
    // alone — the CHECK would refuse a row naming a channel beside it.
    const categorySlices = slices.filter((slice) => slice.categoryId !== null);
    expect(categorySlices).toHaveLength(2);
    for (const slice of categorySlices) {
      expect([slice.groupId, slice.agentId, slice.channel]).toEqual([null, null, null]);
    }
    expect(reconcileFailure(slices)).toBeNull();

    // "No category" is the totals less the category slices, column by column:
    // the unfiled ticket's figures exactly, its working-time seconds included.
    const totals = totalsOf(slices);
    const unfiled = Object.fromEntries(
      COLUMNS.map((column) => [
        column,
        totals[column] - categorySlices.reduce((sum, slice) => sum + slice.bucket[column], 0),
      ]),
    ) as Bucket;
    expect(counted(unfiled)).toEqual(
      figures({
        ticketsCreated: 1,
        firstResponseCount: 1,
        slaFirstResponseMet: 1,
        ticketsResolved: 1,
        resolutionCount: 1,
        ticketsReopened: 1,
        csatSkippedCount: 1,
      }),
    );
    expect(unfiled.firstResponseSecondsSum).toBeGreaterThan(0);
    expect(unfiled.resolutionSecondsSum).toBeGreaterThan(0);
  });

  it('leaves the totals and every other slice as they were before anything was filed', async () => {
    await thirteenth();
    const context = await reportingContext();
    const filed = await computeDay('2026-10-13', context);

    await db.update(conversations).set({ categoryId: null });
    const unfiled = await computeDay('2026-10-13', context);

    // Every figure in every column, the seconds sums too. In no particular
    // order: the reads have none, and the update moved every row.
    expect(totalsOf(filed)).toEqual(totalsOf(unfiled));
    expect(unfiled.some((slice) => slice.categoryId !== null)).toBe(false);
    const others = filed.filter((slice) => slice.categoryId === null);
    expect(others).toHaveLength(unfiled.length);
    expect(others).toEqual(expect.arrayContaining(unfiled));
  });

  // The attribution `rollup.ts` chose, pinned: the ticket's category as it
  // stands, not as of each figure's instant. A person's correction a day
  // later is the ground truth, so computing the 13th again files the 13th's
  // figures under the category the ticket carries now.
  it("moves a day's figures to the category a later relabel gave the ticket", async () => {
    const { sales, support, salesEmail } = await thirteenth();
    const [mona] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test', role: 'agent' })
      .returning({ id: agents.id });
    const context = await reportingContext();
    const before = await computeDay('2026-10-13', context);

    // Re-filed after the day, through the writer the console uses — which
    // stamps its `category_changed` now, well after the 13th.
    expect(await setConversationCategory(salesEmail, support, { agentId: mona!.id })).toEqual({
      outcome: 'changed',
      from: sales,
      to: support,
    });
    const after = await computeDay('2026-10-13', context);

    expect(counted(byCategory(after, sales)?.bucket)).toEqual(
      figures({ ticketsCreated: 1, firstResponseCount: 1, slaFirstResponseBreached: 1 }),
    );
    expect(counted(byCategory(after, support)?.bucket)).toEqual(
      figures({
        ticketsCreated: 2,
        firstResponseCount: 1,
        slaFirstResponseMet: 1,
        ticketsResolved: 2,
        resolutionCount: 2,
        slaResolutionBreached: 1,
        ticketsReopened: 1,
        csatSentCount: 1,
        csatResponseCount: 1,
        csatRating4: 1,
        csatRatingSum: 4,
      }),
    );
    // Moved between categories, never lost: the totals are the day's still.
    expect(totalsOf(after)).toEqual(totalsOf(before));
    expect(reconcileFailure(after)).toBeNull();
  });
});
