import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  autoResponses,
  contacts,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase, withoutCommentChannelCheck } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import { maybeSendAutoResponse } from './index';

/**
 * The out-of-hours acknowledgement against real Postgres, where the decisions
 * the pure tests cannot reach are made: on a public comment thread, whose
 * comment it is, that a passer-by's spends nothing, and what the reply records
 * about where it goes; and on any ticket, the guards a reply sent long after
 * the message needs — the router's hold, the ticket's status, and a person
 * having answered in this closed stretch.
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
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: author,
      bodyText: 'My parcel never came',
      channelMessageId: commentId,
      deliveryStatus: 'delivered',
      meta: { metaKind: 'comment', platform: 'facebook', commentId, isPublic: true },
      createdAt,
    })
    .returning({ id: messages.id });
  return { conversationId, messageId: row!.id };
}

async function acknowledgements(conversationId: string) {
  return db
    .select({ bodyText: messages.bodyText, meta: messages.meta })
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
      bodyEn: 'Hi {{customer_name}}, thanks for your comment — we will reply when we open.',
    });
    const amira = await contact('Amira');
    const bob = await contact('Bob');
    const ticket = await commentTicket(amira);

    // Bob replies under Amira's comment, and his reply is filed on her ticket.
    await maybeSendAutoResponse(
      await comment(ticket, bob, 'post-1_c2', cairo('2026-10-21T22:50')),
      NIGHT,
    );

    expect(await acknowledgements(ticket)).toEqual([]);
    // Nor did it spend the closed stretch Amira's own next comment is owed.
    expect(await respondedAt(ticket)).toBeNull();

    await maybeSendAutoResponse(
      await comment(ticket, amira, 'post-1_c3', cairo('2026-10-21T22:55')),
      NIGHT,
    );

    const sent = await acknowledgements(ticket);
    expect(sent).toHaveLength(1);
    // Named, so a reply Bob writes before the job runs does not become the
    // target; and public, so the timeline badges it as posted.
    expect(sent[0]!.meta).toMatchObject({
      autoResponse: 'out_of_hours',
      isPublic: true,
      commentId: 'post-1_c3',
    });
    // Public, so the contact's name — which may have come from her email — is
    // left out rather than published under the post.
    expect(sent[0]!.bodyText).toBe('Hi, thanks for your comment — we will reply when we open.');
    expect(await respondedAt(ticket)).toEqual(NIGHT);
  });

  // A Meta batch is retried whole when one item fails, so the item that failed
  // is stored after siblings newer than it: here Amira's comment lands after
  // Bob's later reply. Judged by the newest row, her comment would be Bob's and
  // go unanswered.
  it('answers the requester’s comment when it is stored after a passer-by’s newer one', async () => {
    await db.insert(autoResponses).values({
      channel: 'facebook_comment',
      bodyEn: 'Thanks for your comment — we will reply when we open.',
    });
    const amira = await contact('Amira');
    const bob = await contact('Bob');
    const ticket = await commentTicket(amira);

    await maybeSendAutoResponse(
      await comment(ticket, bob, 'post-1_c3', cairo('2026-10-21T22:51')),
      NIGHT,
    );
    expect(await acknowledgements(ticket)).toEqual([]);

    await maybeSendAutoResponse(
      await comment(ticket, amira, 'post-1_c2', cairo('2026-10-21T22:50')),
      NIGHT,
    );

    const sent = await acknowledgements(ticket);
    expect(sent).toHaveLength(1);
    // Under her comment, not under Bob's newer one.
    expect(sent[0]!.meta).toMatchObject({ isPublic: true, commentId: 'post-1_c2' });
  });
});

// The plan's rollback of Stage 1.2 moves the ticket back to `facebook`, where
// a rule for every channel, or for Facebook's messages, would match it on the
// channel alone and post its wording under the comment.
describe('maybeSendAutoResponse, once rolling back 1.2 has moved comments back', () => {
  const { moveCommentsBack } = withoutCommentChannelCheck();

  it('still answers a comment only by a comments rule, and publicly', async () => {
    await db.insert(autoResponses).values([
      { channel: null, bodyEn: 'Thanks for your message, {{customer_name}}.' },
      { channel: 'facebook', bodyEn: 'Thanks for your Facebook message, {{customer_name}}.' },
    ]);
    const amira = await contact('Amira');
    const ticket = await commentTicket(amira);
    expect(await moveCommentsBack()).toBe(1);

    await maybeSendAutoResponse(
      await comment(ticket, amira, 'post-1_c1', cairo('2026-10-21T22:50')),
      NIGHT,
    );
    expect(await acknowledgements(ticket)).toEqual([]);

    await db.insert(autoResponses).values({
      channel: 'facebook_comment',
      bodyEn: 'Hi {{customer_name}}, thanks for your comment — we will reply when we open.',
    });
    await maybeSendAutoResponse(
      await comment(ticket, amira, 'post-1_c2', cairo('2026-10-21T22:55')),
      NIGHT,
    );

    const sent = await acknowledgements(ticket);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.meta).toMatchObject({ isPublic: true, commentId: 'post-1_c2' });
    expect(sent[0]!.bodyText).toBe('Hi, thanks for your comment — we will reply when we open.');
  });
});

/**
 * The guards for a reply sent long after the message — the held reply, which
 * whatever ends a routing hold sends (`afterHoldEnded`), up to forty minutes
 * after the customer wrote (`plans/ticket-category-routing.md`, decision 5).
 * On an email ticket, which no 24-hour window closes.
 */
describe('maybeSendAutoResponse after the message: the hold, the status, an agent’s answer', () => {
  const plus = (instant: Date, minutes: number) => new Date(instant.getTime() + minutes * 60_000);

  async function rule() {
    await db.insert(autoResponses).values({
      bodyEn: 'Thanks for writing — we are closed, and will reply when we open.',
    });
  }

  /** An email ticket the customer wrote to at `wrote`, and their message. */
  async function emailTicket({
    status = 'Open',
    wrote = NIGHT,
    ...values
  }: Partial<typeof conversations.$inferInsert> & { status?: string; wrote?: Date } = {}) {
    const [statusRow] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, status));
    const [requester] = await db
      .insert(contacts)
      .values({ name: 'Amira', primaryEmail: 'amira@example.com' })
      .returning({ id: contacts.id });
    const [row] = await db
      .insert(conversations)
      .values({
        channel: 'email',
        statusId: statusRow!.id,
        requesterContactId: requester!.id,
        lastCustomerMessageAt: wrote,
        ...values,
      })
      .returning({ id: conversations.id });
    return {
      conversationId: row!.id,
      messageId: await customerWrites(row!.id, requester!.id, wrote),
    };
  }

  /** The customer's email, stored at `at`, moving the ticket's clock with it. */
  async function customerWrites(conversationId: string, author: string, at: Date) {
    const [message] = await db
      .insert(messages)
      .values({
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: author,
        bodyText: 'Where is my parcel?',
        deliveryStatus: 'delivered',
        createdAt: at,
      })
      .returning({ id: messages.id });
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: at })
      .where(eq(conversations.id, conversationId));
    return message!.id;
  }

  it('acknowledges an ordinary ticket once in the closed stretch, as it always has', async () => {
    await rule();
    const trigger = await emailTicket();

    await maybeSendAutoResponse(trigger, NIGHT);
    await maybeSendAutoResponse(trigger, plus(NIGHT, 10));

    const sent = await acknowledgements(trigger.conversationId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.meta).toMatchObject({ autoResponse: 'out_of_hours' });
    expect(await respondedAt(trigger.conversationId)).toEqual(NIGHT);
  });

  // Skipped before the claim, so the stretch is still unspent when the hold
  // ends and the reply is owed; claimed then, so the second ender sends nothing.
  it('waits while the ticket is held, spending nothing, and answers once the hold ends', async () => {
    await rule();
    const trigger = await emailTicket({ routingWindowEndsAt: plus(NIGHT, 5) });

    await maybeSendAutoResponse(trigger, NIGHT);

    expect(await acknowledgements(trigger.conversationId)).toEqual([]);
    expect(await respondedAt(trigger.conversationId)).toBeNull();

    await db
      .update(conversations)
      .set({ routingDecidedAt: plus(NIGHT, 5) })
      .where(eq(conversations.id, trigger.conversationId));
    await maybeSendAutoResponse(trigger, plus(NIGHT, 5));
    await maybeSendAutoResponse(trigger, plus(NIGHT, 6));

    expect(await acknowledgements(trigger.conversationId)).toHaveLength(1);
    expect(await respondedAt(trigger.conversationId)).toEqual(plus(NIGHT, 5));
  });

  // The hold, as `assignConversation` reads it: over once the grace runs out
  // on a settle that never came, or once somebody holds the ticket.
  it('answers a ticket no longer held: the grace run out, or somebody holding it', async () => {
    await rule();
    const [omar] = await db
      .insert(agents)
      .values({ name: 'Omar', email: 'omar@shipblu.test' })
      .returning({ id: agents.id });
    const lapsed = await emailTicket({ routingWindowEndsAt: plus(NIGHT, -10) });
    const taken = await emailTicket({
      routingWindowEndsAt: plus(NIGHT, 5),
      assigneeAgentId: omar!.id,
    });

    await maybeSendAutoResponse(lapsed, NIGHT);
    await maybeSendAutoResponse(taken, NIGHT);

    expect(await acknowledgements(lapsed.conversationId)).toHaveLength(1);
    expect(await acknowledgements(taken.conversationId)).toHaveLength(1);
  });

  // A rule or an agent can resolve a ticket while its reply is held, and a
  // pending ticket stays pending when the customer writes.
  it('says nothing on a resolved or closed ticket, and answers a pending one', async () => {
    await rule();
    const resolved = await emailTicket({ status: 'Resolved' });
    const closed = await emailTicket({ status: 'Closed' });
    const pending = await emailTicket({ status: 'Pending' });

    for (const trigger of [resolved, closed, pending]) await maybeSendAutoResponse(trigger, NIGHT);

    expect(await acknowledgements(resolved.conversationId)).toEqual([]);
    expect(await respondedAt(resolved.conversationId)).toBeNull();
    expect(await acknowledgements(closed.conversationId)).toEqual([]);
    expect(await acknowledgements(pending.conversationId)).toHaveLength(1);
  });

  // An agent's reply that ended the hold at 23:02, then the held reply: "we
  // are closed" would contradict the answer the customer has just had.
  it('says nothing once an agent has answered the customer, ties included', async () => {
    await rule();
    const atNight = await emailTicket({ routingWindowEndsAt: plus(NIGHT, 5) });
    await db
      .update(conversations)
      .set({ lastAgentMessageAt: plus(NIGHT, 2), routingDecidedAt: plus(NIGHT, 2) })
      .where(eq(conversations.id, atNight.conversationId));
    // Answered in open hours, and the reply judged at night: the first half of
    // the guard alone, with nothing of the closed stretch about it.
    const afternoon = cairo('2026-10-21T16:00');
    const inHours = await emailTicket({
      wrote: afternoon,
      lastAgentMessageAt: plus(afternoon, 30),
    });
    const tie = await emailTicket({ wrote: afternoon, lastAgentMessageAt: afternoon });

    await maybeSendAutoResponse(atNight, plus(NIGHT, 2));
    await maybeSendAutoResponse(inHours, NIGHT);
    await maybeSendAutoResponse(tie, NIGHT);

    for (const { conversationId } of [atNight, inHours, tie]) {
      expect(await acknowledgements(conversationId)).toEqual([]);
      expect(await respondedAt(conversationId)).toBeNull();
    }
  });

  // Ending a hold by replying out of hours claims nothing, so without the
  // stretch the customer's 23:05 follow-up — newer than the 23:02 answer —
  // was told "we are closed" in the middle of the conversation.
  it('says nothing when an agent answered in this closed stretch, though the customer wrote again since', async () => {
    await rule();
    const opening = await emailTicket({ routingWindowEndsAt: plus(NIGHT, 5) });
    await db
      .update(conversations)
      .set({ lastAgentMessageAt: plus(NIGHT, 2), routingDecidedAt: plus(NIGHT, 2) })
      .where(eq(conversations.id, opening.conversationId));
    await maybeSendAutoResponse(opening, plus(NIGHT, 2));

    const [ticket] = await db
      .select({ requester: conversations.requesterContactId })
      .from(conversations)
      .where(eq(conversations.id, opening.conversationId));
    const followUp = {
      conversationId: opening.conversationId,
      messageId: await customerWrites(opening.conversationId, ticket!.requester, plus(NIGHT, 5)),
    };
    await maybeSendAutoResponse(followUp, plus(NIGHT, 5));

    expect(await acknowledgements(opening.conversationId)).toEqual([]);
    expect(await respondedAt(opening.conversationId)).toBeNull();
  });

  // The same guard on a ticket that never routed, deliberately: an agent
  // staying late answered at 17:30 a message from before closing, and the
  // customer's 17:40 reply to them is not told the office is shut. Before the
  // guard it was, since nothing had claimed the stretch.
  it('says nothing to a customer answering an agent who replied after closing, on any ticket', async () => {
    await rule();
    const trigger = await emailTicket({
      wrote: cairo('2026-10-21T17:40'),
      lastAgentMessageAt: cairo('2026-10-21T17:30'),
    });

    await maybeSendAutoResponse(trigger, cairo('2026-10-21T17:40'));

    expect(await acknowledgements(trigger.conversationId)).toEqual([]);
  });

  // The stretch is the closed one `at` is in: an answer given while the office
  // was open, or in an earlier evening, says nothing about tonight's message.
  it('answers a customer who writes after closing when the agent’s answer was before this stretch', async () => {
    await rule();
    const answeredInHours = await emailTicket({
      lastAgentMessageAt: cairo('2026-10-21T16:00'),
    });
    const answeredLastNight = await emailTicket({
      lastAgentMessageAt: cairo('2026-10-20T23:00'),
    });

    await maybeSendAutoResponse(answeredInHours, NIGHT);
    await maybeSendAutoResponse(answeredLastNight, NIGHT);

    expect(await acknowledgements(answeredInHours.conversationId)).toHaveLength(1);
    expect(await acknowledgements(answeredLastNight.conversationId)).toHaveLength(1);
  });
});
