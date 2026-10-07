import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversationEvents,
  conversations,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { deliverAutomatedReply } from './outbound';

/**
 * The write both automated senders share — the out-of-hours reply and an
 * automation's canned reply — run against Postgres.
 *
 * `outbound.test.ts` checks the statements it builds; only a database can say
 * whether they run. The auto-reply stamp is a `coalesce` in a raw `sql`
 * fragment, and it shipped binding a bare `Date`, which postgres.js refuses:
 * every automated reply stopped after its message row — never sent on a
 * carrier channel, and with no event to tell a time-based rule it had already
 * replied, so the rule wrote it again each sweep.
 */

withCleanDatabase();

async function emailTicket() {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: 'amira@example.test' })
    .returning({ id: contacts.id });
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel: 'email', statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

function acknowledge(conversationId: string, bodyText: string) {
  return deliverAutomatedReply({
    conversationId,
    channel: 'email',
    requesterEmail: 'amira@example.test',
    bodyText,
    bodyHtml: `<p>${bodyText}</p>`,
    actorLabel: 'automation:acknowledge',
    eventType: 'auto_replied',
  });
}

describe('deliverAutomatedReply', () => {
  it('stores the reply, records the event and queues the send', async () => {
    const conversationId = await emailTicket();

    const messageId = await acknowledge(conversationId, 'We have your message.');

    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(message).toMatchObject({
      direction: 'outbound',
      kind: 'reply',
      authorAgentId: null,
      deliveryStatus: 'pending',
      toAddresses: ['amira@example.test'],
    });

    const events = await db
      .select({ type: conversationEvents.type, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId));
    expect(events).toEqual([{ type: 'auto_replied', data: { messageId } }]);

    const queued = await db
      .select({ type: jobs.type, payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `send:${messageId}`));
    expect(queued).toEqual([{ type: 'send_email', payload: { messageId } }]);
  });

  it('stamps the first auto-reply once and leaves it alone after that', async () => {
    const conversationId = await emailTicket();
    const stamp = async () => {
      const [row] = await db
        .select({ at: conversations.firstAutoRepliedAt })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      return row!.at;
    };

    await acknowledge(conversationId, 'We have your message.');
    const first = await stamp();
    expect(first).toBeInstanceOf(Date);

    await acknowledge(conversationId, 'Still with us — an agent will be in touch.');
    expect(await stamp()).toEqual(first);
  });
});
