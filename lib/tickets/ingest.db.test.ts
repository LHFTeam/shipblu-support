import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  jobs,
  messages,
  sideConversationMessages,
  sideConversations,
  ticketStatuses,
} from '@/db/schema';
import { buildReplyAddress, buildSideReplyAddress, buildSubjectTag } from '@/lib/email/threading';
import type { ParsedInboundEmail } from '@/lib/email/types';
import { env } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { ingestInboundEmail } from './ingest';

/**
 * What `ingestInboundEmail` writes today, quirks included, so the shared ingest
 * steps of Stage 4.2 can be proven to change nothing. A test here failing after
 * a refactor is the refactor changing behaviour — decide whether that was meant
 * before touching the expectation.
 *
 * Against the seeded baseline only: no email channel, no SLA policy, no
 * auto-response. So a new ticket has no channel or group, and nothing lands in
 * `jobs` — the lifecycle's enqueues all wait on configuration this database
 * does not have. The categoriser is the one consumer that always writes.
 */

withCleanDatabase();

const RECEIVED = new Date('2026-09-20T10:00:00Z');

function email(overrides: Partial<ParsedInboundEmail> = {}): ParsedInboundEmail {
  return {
    messageId: 'first@customer.example',
    references: [],
    from: { address: 'amira@customer.example', name: 'Amira' },
    to: [{ address: 'support@shipblu.test' }],
    cc: [],
    subject: 'Re: Where is my parcel?',
    textBody: 'Hello, my parcel has not arrived.',
    attachments: [],
    headers: {},
    receivedAt: RECEIVED,
    ...overrides,
  };
}

async function ingested(mail: ParsedInboundEmail) {
  const result = await ingestInboundEmail(mail);
  if (!result) throw new Error('ingest returned null');
  return result;
}

async function conversation(id: string) {
  const [row] = await db
    .select({
      number: conversations.number,
      channel: conversations.channel,
      channelId: conversations.channelId,
      groupId: conversations.groupId,
      subject: conversations.subject,
      status: ticketStatuses.name,
      requesterContactId: conversations.requesterContactId,
      isSpam: conversations.isSpam,
      reopenCount: conversations.reopenCount,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  if (!row) throw new Error(`no conversation ${id}`);
  return row;
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function eventsOf(conversationId: string) {
  const rows = await db
    .select({
      type: conversationEvents.type,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, conversationId))
    .orderBy(asc(conversationEvents.createdAt));
  return rows;
}

async function setStatus(conversationId: string, name: string, extra = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!status) throw new Error(`no status ${name}`);
  await db
    .update(conversations)
    .set({ statusId: status.id, ...extra })
    .where(eq(conversations.id, conversationId));
}

describe('ingestInboundEmail', () => {
  it('opens a ticket for a new sender, and files them as a contact', async () => {
    const result = await ingested(email());

    expect(result).toMatchObject({
      conversationNumber: 1,
      createdConversation: true,
      duplicate: false,
      automationReason: null,
    });

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ name: 'Amira', primaryEmail: 'amira@customer.example' });
    expect(await db.select().from(contactIdentities)).toMatchObject([
      { contactId: contact?.id, channel: 'email', identifier: 'amira@customer.example' },
    ]);

    expect(await conversation(result.conversationId)).toEqual({
      number: 1,
      channel: 'email',
      // No email channel is configured, so there is nothing to take a group from.
      channelId: null,
      groupId: null,
      subject: 'Where is my parcel?',
      status: 'Open',
      requesterContactId: contact?.id,
      isSpam: false,
      reopenCount: 0,
      resolvedAt: null,
      resolvedByAgentId: null,
      lastMessageAt: RECEIVED,
      lastCustomerMessageAt: RECEIVED,
    });

    expect(await messagesOf(result.conversationId)).toMatchObject([
      {
        id: result.messageId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contact?.id,
        bodyText: 'Hello, my parcel has not arrived.',
        channelMessageId: 'first@customer.example',
        fromAddress: 'amira@customer.example',
        toAddresses: ['support@shipblu.test'],
        deliveryStatus: 'delivered',
        meta: { automationReason: null, isAutomated: false, isBounce: false },
        createdAt: RECEIVED,
      },
    ]);

    expect(await eventsOf(result.conversationId)).toMatchObject([
      { type: 'categorised', actorLabel: 'category-detector' },
    ]);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it('files a bounce as spam, off the working queue', async () => {
    const result = await ingested(
      email({ from: { address: 'MAILER-DAEMON@mx.customer.example' }, subject: 'Undeliverable' }),
    );

    expect(result.automationReason).toBe('daemon_sender');
    expect((await conversation(result.conversationId)).isSpam).toBe(true);
  });

  describe('a reply', () => {
    const later = new Date('2026-09-20T11:30:00Z');

    it('threads on the References chain', async () => {
      const first = await ingested(email());
      const reply = await ingested(
        email({
          messageId: 'second@customer.example',
          inReplyTo: 'first@customer.example',
          references: ['first@customer.example'],
          receivedAt: later,
        }),
      );

      expect(reply).toMatchObject({
        conversationId: first.conversationId,
        createdConversation: false,
        duplicate: false,
      });
      expect(await db.select().from(contacts)).toHaveLength(1);
      expect(await messagesOf(first.conversationId)).toHaveLength(2);
      expect(await conversation(first.conversationId)).toMatchObject({
        status: 'Open',
        lastMessageAt: later,
        lastCustomerMessageAt: later,
      });
    });

    it('threads on a signed reply address, with no References at all', async () => {
      const first = await ingested(email());
      const address = buildReplyAddress(1, env().APP_SECRET, 'support', 'shipblu.test');

      const reply = await ingested(
        email({ messageId: 'second@customer.example', to: [{ address }], receivedAt: later }),
      );

      expect(reply.conversationId).toBe(first.conversationId);
    });

    it('threads on a signed subject tag, with no References at all', async () => {
      const first = await ingested(email());
      const tag = buildSubjectTag(1, env().APP_SECRET);

      const reply = await ingested(
        email({
          messageId: 'second@customer.example',
          subject: `Re: Where is my parcel? ${tag}`,
          receivedAt: later,
        }),
      );

      expect(reply.conversationId).toBe(first.conversationId);
    });

    it('reopens a resolved ticket, and records who had resolved it', async () => {
      const first = await ingested(email());
      const [agent] = await db
        .insert(agents)
        .values({ name: 'Omar', email: 'omar@shipblu.test' })
        .returning({ id: agents.id });
      await setStatus(first.conversationId, 'Resolved', {
        resolvedAt: new Date('2026-09-20T10:30:00Z'),
        resolvedByAgentId: agent?.id,
      });

      await ingested(
        email({
          messageId: 'second@customer.example',
          references: ['first@customer.example'],
          receivedAt: later,
        }),
      );

      expect(await conversation(first.conversationId)).toMatchObject({
        status: 'Open',
        reopenCount: 1,
        resolvedAt: null,
        // Deliberately left for the event to read; see the ingest.
        resolvedByAgentId: agent?.id,
      });
      expect((await eventsOf(first.conversationId)).filter((e) => e.type === 'reopened')).toEqual([
        {
          type: 'reopened',
          actorLabel: 'inbound_email',
          data: { reason: 'customer_replied', resolvedBy: agent?.id },
        },
      ]);
    });

    // Recorded, not endorsed: only `resolved` reopens, so a reply to a closed
    // ticket is appended to it and the ticket stays closed.
    it('lands on a closed ticket and leaves it closed', async () => {
      const first = await ingested(email());
      await setStatus(first.conversationId, 'Closed');

      const reply = await ingested(
        email({
          messageId: 'second@customer.example',
          references: ['first@customer.example'],
          receivedAt: later,
        }),
      );

      expect(reply.conversationId).toBe(first.conversationId);
      expect(await conversation(first.conversationId)).toMatchObject({
        status: 'Closed',
        reopenCount: 0,
      });
      expect(await messagesOf(first.conversationId)).toHaveLength(2);
    });

    it('opens a new ticket when the one it threads onto was deleted', async () => {
      const first = await ingested(email());
      await db
        .update(conversations)
        .set({ deletedAt: new Date() })
        .where(eq(conversations.id, first.conversationId));

      const reply = await ingested(
        email({
          messageId: 'second@customer.example',
          references: ['first@customer.example'],
          receivedAt: later,
        }),
      );

      expect(reply).toMatchObject({ createdConversation: true, conversationNumber: 2 });
    });
  });

  it('writes nothing the second time a Message-ID arrives', async () => {
    const first = await ingested(email());
    const again = await ingested(email());

    expect(again).toEqual({
      conversationId: first.conversationId,
      conversationNumber: 1,
      messageId: first.messageId,
      createdConversation: false,
      duplicate: true,
      automationReason: null,
    });
    expect(await messagesOf(first.conversationId)).toHaveLength(1);
    expect(await eventsOf(first.conversationId)).toHaveLength(1);
  });

  it('routes a side conversation reply to it before any contact is resolved', async () => {
    const first = await ingested(email());
    const [side] = await db
      .insert(sideConversations)
      .values({
        conversationId: first.conversationId,
        subject: 'Parcel stuck at the hub',
        toAddresses: ['hub@warehouse.example'],
      })
      .returning({ id: sideConversations.id, number: sideConversations.number });
    if (!side) throw new Error('side conversation not inserted');

    const address = buildSideReplyAddress(side.number, env().APP_SECRET, 'support', 'shipblu.test');
    const result = await ingested(
      email({
        messageId: 'hub-reply@warehouse.example',
        from: { address: 'hub@warehouse.example', name: 'Nasr City hub' },
        to: [{ address }],
        subject: 'Re: Parcel stuck at the hub',
        textBody: 'Found it, out for delivery tomorrow.',
      }),
    );

    expect(result).toMatchObject({
      conversationId: first.conversationId,
      conversationNumber: 1,
      createdConversation: false,
      duplicate: false,
      sideConversationNumber: side.number,
    });

    // The colleague at the hub is not a customer.
    expect(await db.select({ email: contacts.primaryEmail }).from(contacts)).toEqual([
      { email: 'amira@customer.example' },
    ]);
    expect(await messagesOf(first.conversationId)).toHaveLength(1);
    expect(
      await db
        .select({
          direction: sideConversationMessages.direction,
          fromAddress: sideConversationMessages.fromAddress,
          bodyText: sideConversationMessages.bodyText,
        })
        .from(sideConversationMessages)
        .where(eq(sideConversationMessages.sideConversationId, side.id)),
    ).toEqual([
      {
        direction: 'inbound',
        fromAddress: 'hub@warehouse.example',
        bodyText: 'Found it, out for delivery tomorrow.',
      },
    ]);
  });
});
