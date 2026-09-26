import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  groups,
  messages,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { appendReply, createTicket } from './tickets';

/**
 * What the portal's two ingest paths write today, quirks included, so the
 * shared ingest steps of Stage 4.2 can be proven to change nothing.
 *
 * Both take the contact the portal session already resolved, and stamp their
 * own clock. `appendReply` is the one path that finds its ticket by number
 * rather than by thread, and every refusal it can give is pinned here, since a
 * refusal is what stops a customer writing onto a ticket that is not theirs.
 */

withCleanDatabase();

async function customer(name = 'Amira'): Promise<string> {
  const [row] = await db.insert(contacts).values({ name }).returning({ id: contacts.id });
  if (!row) throw new Error('contact not inserted');
  return row.id;
}

async function conversation(id: string) {
  const [row] = await db
    .select({
      number: conversations.number,
      channel: conversations.channel,
      channelId: conversations.channelId,
      groupId: conversations.groupId,
      formId: conversations.formId,
      subject: conversations.subject,
      status: ticketStatuses.name,
      priority: conversations.priority,
      type: conversations.type,
      tags: conversations.tags,
      customFields: conversations.customFields,
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

describe('createTicket', () => {
  it('files a portal ticket, under the column defaults when nothing presets it', async () => {
    const contactId = await customer();
    const before = Date.now();

    const created = await createTicket(contactId, {
      subject: 'Parcel damaged',
      body: 'The box arrived crushed.',
    });
    const after = Date.now();

    expect(created.number).toBe(1);

    const ticket = await conversation(created.conversationId);
    expect(ticket).toMatchObject({
      channel: 'portal',
      // No `portal` channel row is seeded, so no group either.
      channelId: null,
      groupId: null,
      formId: null,
      subject: 'Parcel damaged',
      status: 'Open',
      priority: 'medium',
      type: null,
      tags: [],
      customFields: {},
      requesterContactId: contactId,
    });

    const [message] = await messagesOf(created.conversationId);
    expect(message).toMatchObject({
      id: created.messageId,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: contactId,
      bodyText: 'The box arrived crushed.',
      bodyHtml: null,
      deliveryStatus: 'delivered',
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
      .where(eq(conversationEvents.conversationId, created.conversationId));
    expect(events).toEqual([{ type: 'categorised' }]);
  });

  it('takes what a form presets', async () => {
    const contactId = await customer();
    const [group] = await db.insert(groups).values({ name: 'Claims' }).returning({ id: groups.id });
    const [form] = await db
      .insert(ticketForms)
      .values({ slug: 'claims' })
      .returning({ id: ticketForms.id });

    const created = await createTicket(contactId, {
      subject: 'Claim',
      body: 'Please refund.',
      formId: form?.id,
      groupId: group?.id,
      priority: 'high',
      type: 'claim',
      tags: ['refund'],
      customFields: { order: '5512' },
    });

    expect(await conversation(created.conversationId)).toMatchObject({
      formId: form?.id,
      groupId: group?.id,
      priority: 'high',
      type: 'claim',
      tags: ['refund'],
      customFields: { order: '5512' },
    });
  });
});

describe('appendReply', () => {
  it('adds the customer’s reply to their own ticket', async () => {
    const contactId = await customer();
    const created = await createTicket(contactId, { subject: 'Parcel damaged', body: 'Crushed.' });

    expect(await appendReply(contactId, created.number, 'Photos attached.')).toEqual({ ok: true });

    const [, reply] = await messagesOf(created.conversationId);
    expect(reply).toMatchObject({
      direction: 'inbound',
      authorContactId: contactId,
      bodyText: 'Photos attached.',
    });
    expect((await conversation(created.conversationId)).lastCustomerMessageAt?.getTime()).toBe(
      reply?.createdAt.getTime(),
    );
  });

  it('reopens a resolved ticket, naming who resolved it', async () => {
    const contactId = await customer();
    const created = await createTicket(contactId, { subject: 'Parcel damaged', body: 'Crushed.' });
    const resolver = await resolveAsAgent(created.conversationId);

    expect(await appendReply(contactId, created.number, 'Not fixed.')).toEqual({ ok: true });

    expect(await conversation(created.conversationId)).toMatchObject({
      status: 'Open',
      reopenCount: 1,
      resolvedAt: null,
      resolvedByAgentId: resolver,
    });
    const reopened = await db
      .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.type, 'reopened'));
    expect(reopened).toEqual([
      { actorLabel: 'portal', data: { reason: 'customer_replied', resolvedBy: resolver } },
    ]);
  });

  it('answers on a ticket that arrived on another channel, as inbound', async () => {
    const contactId = await customer();
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [emailed] = await db
      .insert(conversations)
      .values({
        channel: 'email',
        statusId: open!.id,
        subject: 'By mail',
        requesterContactId: contactId,
      })
      .returning({ id: conversations.id, number: conversations.number });

    expect(await appendReply(contactId, emailed!.number, 'Replying from the portal')).toEqual({
      ok: true,
    });
    expect(await messagesOf(emailed!.id)).toMatchObject([
      { direction: 'inbound', bodyText: 'Replying from the portal' },
    ]);
  });

  describe('refuses, writing nothing,', () => {
    async function refused(contactId: string, number: number, conversationId: string) {
      const before = await messagesOf(conversationId);
      expect(await appendReply(contactId, number, 'Let me in')).toEqual({ ok: false });
      expect(await messagesOf(conversationId)).toHaveLength(before.length);
    }

    it('a closed ticket', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Done', body: 'Thanks.' });
      await setStatus(created.conversationId, 'Closed');

      await refused(contactId, created.number, created.conversationId);
    });

    it('somebody else’s ticket', async () => {
      const owner = await customer('Owner');
      const stranger = await customer('Stranger');
      const created = await createTicket(owner, { subject: 'Mine', body: 'Private.' });

      await refused(stranger, created.number, created.conversationId);
    });

    it('a ticket filed as spam', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Spam', body: 'Buy now.' });
      await db
        .update(conversations)
        .set({ isSpam: true })
        .where(eq(conversations.id, created.conversationId));

      await refused(contactId, created.number, created.conversationId);
    });

    it('a deleted ticket', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Gone', body: 'Deleted.' });
      await db
        .update(conversations)
        .set({ deletedAt: new Date() })
        .where(eq(conversations.id, created.conversationId));

      await refused(contactId, created.number, created.conversationId);
    });

    it('a bot transcript, which no customer writes onto', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Bot', body: 'Menu.' });
      await db
        .update(conversations)
        .set({ channel: 'whatsapp_bot' })
        .where(eq(conversations.id, created.conversationId));

      await refused(contactId, created.number, created.conversationId);
    });
  });
});
