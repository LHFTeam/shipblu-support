import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { autoResponses, contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import { maybeSendAutoResponse } from './index';

/**
 * The out-of-hours acknowledgement on a public comment thread, against real
 * Postgres, where the decisions the pure tests cannot reach are made: whose
 * comment it is, that a passer-by's spends nothing, and what the reply records
 * about where it goes.
 *
 * Built from rows rather than through `ingestMetaComment`, which would call this
 * itself at the real clock and make the test depend on the hour it runs.
 */

withCleanDatabase();

// Closed under the seeded week (Sunday to Thursday, 09:00 to 17:00).
const NIGHT = cairo('2026-10-21T23:00');

async function contact(name: string) {
  const [row] = await db.insert(contacts).values({ name }).returning({ id: contacts.id });
  return row!.id;
}

async function commentTicket(requester: string) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'facebook_comment',
      externalId: 'facebook:comment:post-1_c1',
      statusId: status!.id,
      requesterContactId: requester,
      lastCustomerMessageAt: NIGHT,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function comment(conversationId: string, author: string, commentId: string, createdAt: Date) {
  await db.insert(messages).values({
    conversationId,
    direction: 'inbound',
    kind: 'reply',
    authorContactId: author,
    bodyText: 'My parcel never came',
    channelMessageId: commentId,
    deliveryStatus: 'delivered',
    meta: { metaKind: 'comment', platform: 'facebook', commentId, isPublic: true },
    createdAt,
  });
}

async function acknowledgements(conversationId: string) {
  return db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));
}

async function respondedAt(conversationId: string) {
  const [row] = await db
    .select({ at: conversations.autoRespondedAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row!.at;
}

describe('maybeSendAutoResponse on a comment ticket', () => {
  it('answers the requester, not a passer-by, and posts under the requester’s comment', async () => {
    await db.insert(autoResponses).values({
      channel: 'facebook_comment',
      bodyEn: 'Thanks for your comment — we will reply when we open.',
    });
    const amira = await contact('Amira');
    const bob = await contact('Bob');
    const ticket = await commentTicket(amira);

    // Bob replies under Amira's comment, and his reply is filed on her ticket.
    await comment(ticket, bob, 'post-1_c2', cairo('2026-10-21T22:50'));
    await maybeSendAutoResponse(ticket, NIGHT);

    expect(await acknowledgements(ticket)).toEqual([]);
    // Nor did it spend the closed stretch Amira's own next comment is owed.
    expect(await respondedAt(ticket)).toBeNull();

    await comment(ticket, amira, 'post-1_c3', cairo('2026-10-21T22:55'));
    await maybeSendAutoResponse(ticket, NIGHT);

    const sent = await acknowledgements(ticket);
    expect(sent).toHaveLength(1);
    // Named, so a reply Bob writes before the job runs does not become the
    // target; and public, so the timeline badges it as posted.
    expect(sent[0]!.meta).toMatchObject({
      autoResponse: 'out_of_hours',
      isPublic: true,
      commentId: 'post-1_c3',
    });
    expect(await respondedAt(ticket)).toEqual(NIGHT);
  });
});
