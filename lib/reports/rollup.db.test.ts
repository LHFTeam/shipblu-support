import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, csatSurveys, groups, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { computeDay, reconciles, reportingContext, totalsOf, type Slice } from './rollup';

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
    expect(reconciles(thirteenth)).toBe(true);

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
