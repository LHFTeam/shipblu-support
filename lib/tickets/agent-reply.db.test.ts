import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, jobs, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { storeAgentReply } from './agent-reply';

/**
 * The sequence both console senders share once their checks have passed. What
 * it must get right is what separates an agent's reply from an automated one:
 * the ticket leaves the unanswered queue and the response clock stops, and the
 * send is queued exactly once — or not at all on web chat, whose row is its
 * delivery.
 */

withCleanDatabase();

// Far enough back that a stamp left at its default cannot pass for one the
// reply moved.
const LAST_MESSAGE_AT = new Date('2026-09-01T09:00:00Z');

async function ticket(channel: 'email' | 'whatsapp' | 'webchat' | 'facebook') {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({
      channel,
      statusId: open!.id,
      requesterContactId: contact!.id,
      lastMessageAt: LAST_MESSAGE_AT,
    })
    .returning({ id: conversations.id });
  return { id: row!.id, agentId: agent!.id };
}

describe('storeAgentReply', () => {
  it('stores the reply, marks the ticket answered and queues it on its carrier', async () => {
    const { id, agentId } = await ticket('whatsapp');

    const messageId = await storeAgentReply(id, 'whatsapp', {
      authorAgentId: agentId,
      bodyText: 'Your parcel is on its way.',
      deliveryStatus: 'pending',
      meta: { sendKind: 'text' },
    });

    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(message).toMatchObject({
      conversationId: id,
      direction: 'outbound',
      kind: 'reply',
      authorAgentId: agentId,
      bodyText: 'Your parcel is on its way.',
      deliveryStatus: 'pending',
      meta: { sendKind: 'text' },
    });

    const [row] = await db
      .select({
        lastMessageAt: conversations.lastMessageAt,
        lastAgentMessageAt: conversations.lastAgentMessageAt,
        firstRespondedAt: conversations.firstRespondedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.lastAgentMessageAt).toBeInstanceOf(Date);
    expect(row!.lastMessageAt.getTime()).toBeGreaterThan(LAST_MESSAGE_AT.getTime());
    expect(row!.firstRespondedAt).toBeInstanceOf(Date);

    expect(
      await db
        .select({ type: jobs.type, payload: jobs.payload, priority: jobs.priority })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `send:${messageId}`)),
    ).toEqual([{ type: 'send_whatsapp', payload: { messageId }, priority: 10 }]);
  });

  it.each([
    ['email', 'send_email'],
    ['facebook', 'send_meta'],
  ] as const)('sends a %s ticket by %s', async (channel, carrier) => {
    const { id, agentId } = await ticket(channel);

    const messageId = await storeAgentReply(id, channel, {
      authorAgentId: agentId,
      bodyText: 'Thanks for waiting.',
      deliveryStatus: 'pending',
    });

    expect(
      await db
        .select({ type: jobs.type })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `send:${messageId}`)),
    ).toEqual([{ type: carrier }]);
  });

  it('queues nothing on web chat, whose row is its delivery', async () => {
    const { id, agentId } = await ticket('webchat');

    await storeAgentReply(id, 'webchat', {
      authorAgentId: agentId,
      bodyText: 'Hello!',
      deliveryStatus: 'delivered',
      deliveredAt: new Date(),
    });

    expect(await db.select({ id: jobs.id }).from(jobs)).toEqual([]);
    const [row] = await db
      .select({ lastAgentMessageAt: conversations.lastAgentMessageAt })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.lastAgentMessageAt).toBeInstanceOf(Date);
  });
});
