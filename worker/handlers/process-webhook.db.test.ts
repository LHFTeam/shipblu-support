import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  conversations,
  messages,
  sideConversationMessages,
  sideConversations,
  slaPolicies,
  webhookEvents,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { buildSideReplyAddress } from '@/lib/email/threading';
import { env, resetEnvCache } from '@/lib/env';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { getConversation } from '@/lib/tickets/conversation';
import { listInbox } from '@/lib/tickets/inbox';
import { parseFilters } from '@/lib/tickets/inbox-filters';
import { processWebhook } from './process-webhook';

/**
 * An inbound email's time is when it reached us, and this is where that instant
 * enters: `webhook_events.received_at`, through this handler, into ingest.
 *
 * It used to be the mail's own `Date` header, which is the sender's clock. The
 * ordering bug that caused hides in exactly this seam — a test that hands
 * `ingestInboundEmail` a ready-made `receivedAt` cannot see which value the
 * pipeline would have put there — so every case here goes through a stored
 * Postmark delivery and the real parser, and reads the result back through the
 * three things an agent sees: the ticket's timeline, the card's preview, and the
 * list's order.
 *
 * The fixture instants are all days before the test runs, so a row stamped with
 * the worker's own clock would fail these as surely as one stamped from the
 * header: the instant being asserted belongs to the delivery.
 */

vi.stubEnv('EMAIL_PROVIDER', 'postmark');
vi.stubEnv('EMAIL_API_KEY', 'db-test-placeholder');
resetEnvCache();

withCleanDatabase();

/** A Cairo wall-clock time on the fixture day. Converted by the tz database, never by hand. */
function cairo(time: string): DateTime {
  return DateTime.fromISO(`2026-09-20T${time}`, { zone: 'Africa/Cairo' });
}

type Delivery = {
  messageId: string;
  from?: string;
  to?: string;
  /** The `Date` header exactly as the sender's client wrote it, or absent. */
  date?: string;
  references?: string[];
  text: string;
  /** When our endpoint stored the delivery. */
  receivedAt: DateTime;
};

/** Stores a Postmark delivery the way the webhook route does, and returns its row id. */
async function store(mail: Delivery): Promise<string> {
  const headers = [{ Name: 'Message-ID', Value: `<${mail.messageId}>` }];
  if (mail.references?.length) {
    headers.push({ Name: 'References', Value: mail.references.map((r) => `<${r}>`).join(' ') });
  }

  const [event] = await db
    .insert(webhookEvents)
    .values({
      provider: 'postmark',
      channel: 'email',
      providerEventId: `pm-${mail.messageId}`,
      payload: {
        MessageID: `pm-${mail.messageId}`,
        FromFull: { Email: mail.from ?? 'amira@customer.example', Name: 'Amira' },
        ToFull: [{ Email: mail.to ?? 'support@shipblu.test' }],
        Subject: 'Where is my parcel?',
        TextBody: mail.text,
        ...(mail.date !== undefined && { Date: mail.date }),
        Headers: headers,
      },
      signatureVerified: true,
      receivedAt: mail.receivedAt.toJSDate(),
    })
    .returning({ id: webhookEvents.id });
  return event!.id;
}

/** Runs the job for a stored delivery, whenever the worker gets to it. */
async function run(webhookEventId: string): Promise<void> {
  await processWebhook({
    id: 'job-1',
    type: 'process_webhook',
    payload: { webhookEventId },
  } as unknown as ClaimedJob);
}

async function deliver(mail: Delivery): Promise<void> {
  await run(await store(mail));
}

async function admin(): Promise<SessionAgent> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', role: 'admin' })
    .returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions: {},
    avatarUrl: null,
    avatarColor: row!.avatarColor,
    isAcceptingTickets: true,
    sessionIdleForMs: 0,
  };
}

async function ticketOf(messageId: string) {
  const [row] = await db
    .select({ id: conversations.id, number: conversations.number })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(eq(messages.channelMessageId, messageId));
  if (!row) throw new Error(`no ticket holds ${messageId}`);
  return row;
}

/** What `storeAgentReply` and `onAgentReply` write, at a chosen instant. */
async function agentReplies(conversationId: string, agentId: string, at: DateTime, text: string) {
  await db.insert(messages).values({
    conversationId,
    direction: 'outbound',
    kind: 'reply',
    authorAgentId: agentId,
    bodyText: text,
    deliveryStatus: 'sent',
    createdAt: at.toJSDate(),
  });
  await db
    .update(conversations)
    .set({
      lastMessageAt: at.toJSDate(),
      lastAgentMessageAt: at.toJSDate(),
      firstRespondedAt: at.toJSDate(),
      nextResponseDueAt: null,
    })
    .where(eq(conversations.id, conversationId));
}

/** The default policy, so `applySlaOnCreate` gives every new ticket an hour. */
async function hourlyPolicy() {
  const target = { firstResponseMins: 60, nextResponseMins: 60, resolutionMins: 1440 };
  await db.insert(slaPolicies).values({
    name: 'every hour',
    hoursSource: 'round_the_clock',
    isDefault: true,
    targets: { low: target, medium: target, high: target, urgent: target },
  });
}

async function clocksOf(conversationId: string) {
  const [row] = await db
    .select({
      createdAt: conversations.createdAt,
      firstResponseDueAt: conversations.firstResponseDueAt,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      nextResponseDueAt: conversations.nextResponseDueAt,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row!;
}

describe('processWebhook — when an inbound email happened', () => {
  // The case from review on #324: we answer at 10:00, the customer answers at
  // 10:30 from a device whose clock reads 08:30.
  it('puts a reply from a customer whose clock is behind after the reply it answers', async () => {
    const agent = await admin();
    await hourlyPolicy();
    const opened = cairo('09:00');
    const arrived = opened.plus({ seconds: 20 });
    await deliver({
      messageId: 'first@customer.example',
      date: opened.toRFC2822()!,
      text: 'My parcel has not arrived.',
      receivedAt: arrived,
    });
    const ticket = await ticketOf('first@customer.example');

    // The ticket itself began when the mail reached us, and so did its
    // first-response target. On the insert's own `now()` both would be today.
    expect(await clocksOf(ticket.id)).toMatchObject({
      createdAt: arrived.toJSDate(),
      firstResponseDueAt: arrived.plus({ hours: 1 }).toJSDate(),
    });

    await agentReplies(ticket.id, agent.id, cairo('10:00'), 'It is out for delivery today.');

    // Somebody else's ticket, last touched between our reply and the answer.
    await deliver({
      messageId: 'other@customer.example',
      from: 'karim@customer.example',
      date: cairo('10:15').toRFC2822()!,
      text: 'Can I change my address?',
      receivedAt: cairo('10:15').plus({ seconds: 20 }),
    });
    const other = await ticketOf('other@customer.example');

    const answered = cairo('10:30');
    const deviceClock = answered.minus({ hours: 2 });
    await deliver({
      messageId: 'second@customer.example',
      references: ['first@customer.example'],
      date: deviceClock.toRFC2822()!,
      text: 'Nobody came.',
      receivedAt: answered,
    });

    // The timeline: the customer's answer is last, not first.
    const detail = await getConversation(agent, ticket.number);
    expect(detail!.messages.map((m) => m.bodyText)).toEqual([
      'My parcel has not arrived.',
      'It is out for delivery today.',
      'Nobody came.',
    ]);
    const answer = detail!.messages.at(-1)!;
    expect(answer.createdAt).toEqual(answered.toJSDate());
    // The header is kept as what the sender claimed, and read by nothing.
    expect(answer.meta.dateHeader).toBe(deviceClock.toJSDate().toISOString());

    // The list: above the ticket touched at 10:15, previewing the answer, and
    // with no reply arrow, because the answer is the customer's. On the header
    // the card would have previewed our reply and shown the arrow, and an agent
    // scanning for tickets that need a move would have skipped this one.
    const { rows } = await listInbox(agent, parseFilters({}));
    expect(rows.map((row) => [row.id, row.preview, row.lastFromUs])).toEqual([
      [ticket.id, 'Nobody came.', false],
      [other.id, 'Can I change my address?', false],
    ]);

    // The clocks: a reply is owed an hour from when it reached us. From the
    // header, it would have been overdue an hour before it arrived.
    expect(await clocksOf(ticket.id)).toMatchObject({
      lastMessageAt: answered.toJSDate(),
      lastCustomerMessageAt: answered.toJSDate(),
      nextResponseDueAt: answered.plus({ hours: 1 }).toJSDate(),
    });
  });

  // Each delivery keeps the instant it arrived, so the one processed last is
  // not always the newest: the worker claims several at once, and a failed
  // attempt retries behind a later mail. Processed in that order, the older
  // mail must not pull the ticket's clocks back to itself.
  it('does not move the ticket back when an older mail is processed after a newer one', async () => {
    const agent = await admin();
    await deliver({
      messageId: 'first@customer.example',
      date: cairo('09:00').toRFC2822()!,
      text: 'My parcel has not arrived.',
      receivedAt: cairo('09:00'),
    });
    const ticket = await ticketOf('first@customer.example');

    const older = await store({
      messageId: 'second@customer.example',
      references: ['first@customer.example'],
      date: cairo('10:00').toRFC2822()!,
      text: 'Any news?',
      receivedAt: cairo('10:00'),
    });
    const newer = await store({
      messageId: 'third@customer.example',
      references: ['first@customer.example'],
      date: cairo('10:05').toRFC2822()!,
      text: 'Hello?',
      receivedAt: cairo('10:05'),
    });
    await deliver({
      messageId: 'other@customer.example',
      from: 'karim@customer.example',
      date: cairo('10:02').toRFC2822()!,
      text: 'Can I change my address?',
      receivedAt: cairo('10:02'),
    });
    const other = await ticketOf('other@customer.example');

    await run(newer);
    await run(older);

    const detail = await getConversation(agent, ticket.number);
    expect(detail!.messages.map((m) => m.bodyText)).toEqual([
      'My parcel has not arrived.',
      'Any news?',
      'Hello?',
    ]);
    expect(await clocksOf(ticket.id)).toMatchObject({
      lastMessageAt: cairo('10:05').toJSDate(),
      lastCustomerMessageAt: cairo('10:05').toJSDate(),
    });
    const { rows } = await listInbox(agent, parseFilters({}));
    expect(rows.map((row) => [row.id, row.preview])).toEqual([
      [ticket.id, 'Hello?'],
      [other.id, 'Can I change my address?'],
    ]);
  });

  // The other direction, and the example `lifecycle.ts` gives: a clock reading
  // 23:00 at 11:00 Cairo. From the header the ticket would sit at the top of
  // the list for twelve hours, above everything that arrived after it.
  it('does not let a sender whose clock is ahead hold the top of the list', async () => {
    const agent = await admin();
    const arrived = cairo('11:00');
    await deliver({
      messageId: 'ahead@customer.example',
      date: cairo('23:00').toRFC2822()!,
      text: 'Hello?',
      receivedAt: arrived,
    });
    const ahead = await ticketOf('ahead@customer.example');

    await deliver({
      messageId: 'later@customer.example',
      from: 'karim@customer.example',
      date: cairo('11:30').toRFC2822()!,
      text: 'Is anyone there?',
      receivedAt: cairo('11:30'),
    });
    const later = await ticketOf('later@customer.example');

    const { rows } = await listInbox(agent, parseFilters({}));
    expect(rows.map((row) => row.id)).toEqual([later.id, ahead.id]);

    const detail = await getConversation(agent, ahead.number);
    expect(detail!.messages[0]!.createdAt).toEqual(arrived.toJSDate());
  });

  // `new Date('not a date')` is an Invalid Date, and inserting one throws. So a
  // header nobody had to get right for the mail to be delivered used to send
  // the job to `dead`, and a hand replay failed the same way.
  it.each([
    ['does not parse', 'not a date'],
    ['is absent', undefined],
  ])('lands a mail whose Date header %s, and records no claim', async (_, date) => {
    const agent = await admin();
    const arrived = cairo('12:00');
    await deliver({
      messageId: 'undated@customer.example',
      date,
      text: 'Any news?',
      receivedAt: arrived,
    });

    const ticket = await ticketOf('undated@customer.example');
    const detail = await getConversation(agent, ticket.number);
    expect(detail!.messages).toMatchObject([
      { bodyText: 'Any news?', createdAt: arrived.toJSDate() },
    ]);
    expect(detail!.messages[0]!.meta.dateHeader).toBeNull();
  });

  // The same seam feeds side conversations. The card's side-thread badge is
  // decided by the newest message there, ordered the same way, and the hub's
  // answer is what floats the ticket back up the list.
  it("puts a hub's reply with a slow clock after the message it answers", async () => {
    const agent = await admin();
    await deliver({
      messageId: 'first@customer.example',
      date: cairo('09:00').toRFC2822()!,
      text: 'My parcel has not arrived.',
      receivedAt: cairo('09:00'),
    });
    const ticket = await ticketOf('first@customer.example');

    const [side] = await db
      .insert(sideConversations)
      .values({
        conversationId: ticket.id,
        subject: 'Parcel stuck at the hub',
        toAddresses: ['hub@warehouse.example'],
      })
      .returning({ id: sideConversations.id, number: sideConversations.number });
    await db.insert(sideConversationMessages).values({
      sideConversationId: side!.id,
      direction: 'outbound',
      authorAgentId: agent.id,
      toAddresses: ['hub@warehouse.example'],
      bodyText: 'Can you find this one?',
      deliveryStatus: 'sent',
      createdAt: cairo('10:00').toJSDate(),
    });

    // Somebody else's ticket, last touched between our question and the answer.
    await deliver({
      messageId: 'other@customer.example',
      from: 'karim@customer.example',
      date: cairo('10:15').toRFC2822()!,
      text: 'Can I change my address?',
      receivedAt: cairo('10:15'),
    });
    const other = await ticketOf('other@customer.example');

    const answered = cairo('10:30');
    const hubClock = answered.minus({ hours: 2 });
    await deliver({
      messageId: 'hub-reply@warehouse.example',
      from: 'hub@warehouse.example',
      to: buildSideReplyAddress(side!.number, env().APP_SECRET, 'support', 'shipblu.test'),
      date: hubClock.toRFC2822()!,
      text: 'Found it, out for delivery tomorrow.',
      receivedAt: answered,
    });

    const [reply] = await db
      .select({
        createdAt: sideConversationMessages.createdAt,
        meta: sideConversationMessages.meta,
      })
      .from(sideConversationMessages)
      .where(eq(sideConversationMessages.direction, 'inbound'));
    expect(reply).toMatchObject({
      createdAt: answered.toJSDate(),
      meta: { dateHeader: hubClock.toJSDate().toISOString() },
    });
    const [thread] = await db
      .select({ lastInboundAt: sideConversations.lastInboundAt })
      .from(sideConversations)
      .where(eq(sideConversations.id, side!.id));
    expect(thread!.lastInboundAt).toEqual(answered.toJSDate());

    const { rows } = await listInbox(agent, parseFilters({}));
    expect(rows.map((row) => [row.id, row.sideState])).toEqual([
      [ticket.id, 'replied'],
      [other.id, null],
    ]);
  });
});
