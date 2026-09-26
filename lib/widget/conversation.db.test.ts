import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { appendVisitorMessage } from './conversation';

/**
 * What the widget's ingest path writes today, quirks included, so the shared
 * ingest steps of Stage 4.2 can be proven to change nothing.
 *
 * It takes the contact the visitor's token already resolved to, so each test
 * writes that contact itself. And it stamps its own clock rather than taking
 * one, so instants are asserted against the moments either side of the call.
 */

withCleanDatabase();

async function visitor(): Promise<string> {
  const [row] = await db.insert(contacts).values({ name: null }).returning({ id: contacts.id });
  if (!row) throw new Error('contact not inserted');
  return row.id;
}

async function conversation(id: string) {
  const [row] = await db
    .select({
      number: conversations.number,
      channel: conversations.channel,
      channelId: conversations.channelId,
      subject: conversations.subject,
      status: ticketStatuses.name,
      requesterContactId: conversations.requesterContactId,
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

/** Resolves a ticket the way an agent does: status, time and who. */
async function resolveAsAgent(conversationId: string): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  if (!agent) throw new Error('no agent');
  await setStatus(conversationId, 'Resolved', {
    resolvedAt: new Date('2026-09-20T10:30:00Z'),
    resolvedByAgentId: agent.id,
  });
  return agent.id;
}

describe('appendVisitorMessage', () => {
  it('opens a web chat for a visitor’s first message', async () => {
    const contactId = await visitor();
    const before = Date.now();

    const result = await appendVisitorMessage(contactId, 'Hi, where is my parcel?', {
      pageUrl: 'https://shipblu.com/track',
      userAgent: 'Mozilla/5.0',
    });
    const after = Date.now();

    expect(result.createdConversation).toBe(true);

    const ticket = await conversation(result.conversationId);
    expect(ticket).toMatchObject({
      number: 1,
      channel: 'webchat',
      channelId: null,
      subject: 'Hi, where is my parcel?',
      status: 'Open',
      requesterContactId: contactId,
    });

    const [message] = await messagesOf(result.conversationId);
    expect(message).toMatchObject({
      id: result.messageId,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: contactId,
      bodyText: 'Hi, where is my parcel?',
      // No HTML part, and no channel id: nothing to thread or dedupe on.
      bodyHtml: null,
      channelMessageId: null,
      deliveryStatus: 'delivered',
      meta: { pageUrl: 'https://shipblu.com/track', userAgent: 'Mozilla/5.0' },
    });

    // One clock for the whole write: the message and both conversation stamps.
    const at = message?.createdAt.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(message?.deliveredAt?.getTime()).toBe(at);
    expect(ticket.lastMessageAt?.getTime()).toBe(at);
    expect(ticket.lastCustomerMessageAt?.getTime()).toBe(at);

    const events = await db
      .select({ type: conversationEvents.type })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, result.conversationId));
    expect(events).toEqual([{ type: 'categorised' }]);
  });

  it('continues the visitor’s live chat', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    const second = await appendVisitorMessage(contactId, 'Anyone there?');

    expect(second).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(await messagesOf(first.conversationId)).toHaveLength(2);
  });

  // Recorded, not endorsed: there is no message id to dedupe on, so a retried
  // POST from the widget is a second message.
  it('has no duplicate check: the same text twice is two messages', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    await appendVisitorMessage(contactId, 'Hello');

    expect(await messagesOf(first.conversationId)).toHaveLength(2);
  });

  it('reopens a resolved chat, with its own reason on the event', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    const resolver = await resolveAsAgent(first.conversationId);

    await appendVisitorMessage(contactId, 'One more thing');

    expect(await conversation(first.conversationId)).toMatchObject({
      status: 'Open',
      reopenCount: 1,
      resolvedAt: null,
      // Left for the event to read, as the email path leaves it.
      resolvedByAgentId: resolver,
    });
    const reopened = await db
      .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.type, 'reopened'));
    // `visitor_replied`, where every other path says `customer_replied`.
    expect(reopened).toEqual([
      { actorLabel: 'webchat', data: { reason: 'visitor_replied', resolvedBy: resolver } },
    ]);
  });

  it('starts a new chat after the last one was closed', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    await setStatus(first.conversationId, 'Closed');

    const second = await appendVisitorMessage(contactId, 'Back again');

    expect(second.createdConversation).toBe(true);
    expect(second.conversationId).not.toBe(first.conversationId);
  });

  it('names an empty first message "Web chat"', async () => {
    const contactId = await visitor();
    const result = await appendVisitorMessage(contactId, '');

    expect((await conversation(result.conversationId)).subject).toBe('Web chat');
  });
});
