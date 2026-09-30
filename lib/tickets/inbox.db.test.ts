import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { withCleanDatabase } from '@/lib/testing/db';
import { getConversation } from './conversation';
import { listInbox } from './inbox';
import { parseFilters } from './inbox-filters';

/**
 * The inbox list's read model. What is pinned here is what the list decides a
 * badge from: a Facebook or Instagram comment ticket has no messaging window,
 * and the row has to say so, or the list badges "window closed" on a ticket
 * the header rightly shows none for; and the reply arrow, which has to be
 * about the same message the preview shows, and that message has to be one the
 * customer actually saw.
 */

withCleanDatabase();

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
    isAcceptingTickets: true,
    sessionIdleForMs: 0,
  };
}

async function ticket(
  channel: 'facebook' | 'instagram' | 'whatsapp' | 'webchat' | 'email' | 'portal',
  externalId: string | null,
  assigneeAgentId: string | null = null,
) {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
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
      externalId,
      assigneeAgentId,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('listInbox', () => {
  it('marks a Meta comment ticket, and not a direct-message one', async () => {
    const agent = await admin();
    const comment = await ticket('instagram', 'instagram:comment:17900000000000001');
    const facebookComment = await ticket('facebook', 'facebook:comment:123_456');
    const message = await ticket('facebook', null);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row.isComment]));

    expect(byId.get(comment)).toBe(true);
    expect(byId.get(facebookComment)).toBe(true);
    expect(byId.get(message)).toBe(false);
  });

  it('marks a ticket whose newest visible message is ours, and ignores notes', async () => {
    const agent = await admin();
    const answered = await ticket('facebook', null);
    const waiting = await ticket('facebook', null);
    const notedAfterReply = await ticket('facebook', null);
    const silent = await ticket('facebook', null);

    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
    await db.insert(messages).values([
      { conversationId: answered, direction: 'inbound', bodyText: 'وين شحنتي؟', createdAt: at(0) },
      // An automated reply carries no author and is still ours.
      { conversationId: answered, direction: 'outbound', bodyText: 'On its way', createdAt: at(1) },

      { conversationId: waiting, direction: 'outbound', bodyText: 'On its way', createdAt: at(0) },
      { conversationId: waiting, direction: 'inbound', bodyText: 'Thanks', createdAt: at(1) },

      // A note is written after our reply but the customer never sees it, so
      // the reply is still the last word — and the preview says the same.
      { conversationId: notedAfterReply, direction: 'inbound', bodyText: 'Hi', createdAt: at(0) },
      {
        conversationId: notedAfterReply,
        direction: 'outbound',
        bodyText: 'Hello',
        authorAgentId: agent.id,
        createdAt: at(1),
      },
      {
        conversationId: notedAfterReply,
        direction: 'outbound',
        kind: 'note',
        bodyText: 'Check with the hub',
        authorAgentId: agent.id,
        createdAt: at(2),
      },
    ]);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(answered)).toMatchObject({ lastFromUs: true, preview: 'On its way' });
    expect(byId.get(waiting)).toMatchObject({ lastFromUs: false, preview: 'Thanks' });
    expect(byId.get(notedAfterReply)).toMatchObject({ lastFromUs: true, preview: 'Hello' });
    expect(byId.get(silent)).toMatchObject({ lastFromUs: false, preview: null });
  });

  it('carries the assignee for the tile, and nothing for an unassigned ticket', async () => {
    const agent = await admin();
    const [assignee] = await db
      .insert(agents)
      .values({
        name: 'Dina Mostafa',
        email: 'dina@shipblu.test',
        avatarUrl: 'https://example.test/dina.png',
      })
      .returning();
    const assigned = await ticket('instagram', null, assignee!.id);
    const unassigned = await ticket('instagram', null);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(assigned)).toMatchObject({
      assigneeId: assignee!.id,
      assigneeName: 'Dina Mostafa',
      assigneeAvatarUrl: 'https://example.test/dina.png',
    });
    expect(byId.get(unassigned)).toMatchObject({
      assigneeId: null,
      assigneeName: null,
      assigneeAvatarUrl: null,
    });
  });

  it('skips what the customer never saw: a system notice, a failed send, an autoresponder', async () => {
    const agent = await admin();
    const noticeAfterAck = await ticket('facebook', null);
    const failedReply = await ticket('facebook', null);
    const bouncedReply = await ticket('email', null);
    const outOfOffice = await ticket('email', null);

    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
    await db.insert(messages).values([
      // The form path: the customer's message, our acknowledgement, and then an
      // inbound notice to the team that an attachment was not stored.
      { conversationId: noticeAfterAck, direction: 'inbound', bodyText: 'Hi', createdAt: at(0) },
      {
        conversationId: noticeAfterAck,
        direction: 'outbound',
        bodyText: 'We got your request',
        createdAt: at(1),
      },
      {
        conversationId: noticeAfterAck,
        direction: 'inbound',
        kind: 'system',
        bodyText: 'Could not store x.pdf — ask the customer to send it again.',
        createdAt: at(2),
      },

      // Our reply never arrived, so the customer is still the one waiting.
      {
        conversationId: failedReply,
        direction: 'inbound',
        bodyText: 'وين شحنتي؟',
        createdAt: at(0),
      },
      {
        conversationId: failedReply,
        direction: 'outbound',
        bodyText: 'On its way',
        authorAgentId: agent.id,
        deliveryStatus: 'failed',
        createdAt: at(1),
      },
      { conversationId: bouncedReply, direction: 'inbound', bodyText: 'Refund?', createdAt: at(0) },
      {
        conversationId: bouncedReply,
        direction: 'outbound',
        bodyText: 'Refunded',
        authorAgentId: agent.id,
        deliveryStatus: 'bounced',
        createdAt: at(1),
      },

      // The customer's mail server answering our reply asks nothing of us.
      { conversationId: outOfOffice, direction: 'inbound', bodyText: 'Refund?', createdAt: at(0) },
      {
        conversationId: outOfOffice,
        direction: 'outbound',
        bodyText: 'Refunded',
        authorAgentId: agent.id,
        deliveryStatus: 'delivered',
        createdAt: at(1),
      },
      {
        conversationId: outOfOffice,
        direction: 'inbound',
        bodyText: 'I am out of the office until Sunday',
        meta: { isAutoReply: true },
        createdAt: at(2),
      },
    ]);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(noticeAfterAck)).toMatchObject({
      lastFromUs: true,
      preview: 'We got your request',
    });
    expect(byId.get(failedReply)).toMatchObject({ lastFromUs: false, preview: 'وين شحنتي؟' });
    expect(byId.get(bouncedReply)).toMatchObject({ lastFromUs: false, preview: 'Refund?' });
    expect(byId.get(outOfOffice)).toMatchObject({ lastFromUs: true, preview: 'Refunded' });
  });

  it('breaks a tie on created_at the way the ticket timeline does', async () => {
    const agent = await admin();
    const tied = await ticket('facebook', null);

    // Two rows stamped with one instant, as a provider's second-precision
    // `sentAt` or a batch sharing one `now` produces. The ids are fixed so that
    // insertion order and id order disagree: inserted first but with the larger
    // id, the customer's row is what the id tiebreak picks, and a timeline that
    // fell back to the heap's order would show ours last instead.
    const same = new Date(Date.UTC(2026, 8, 1, 10, 0));
    await db.insert(messages).values([
      {
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        conversationId: tied,
        direction: 'inbound',
        bodyText: 'from them',
        createdAt: same,
      },
      {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: tied,
        direction: 'outbound',
        bodyText: 'from us',
        createdAt: same,
      },
    ]);

    const { rows } = await listInbox(agent, parseFilters({}));
    const row = rows.find((candidate) => candidate.id === tied)!;
    const detail = await getConversation(agent, row.number);
    const shownLast = detail!.messages.at(-1)!;

    expect(row).toMatchObject({ preview: 'from them', lastFromUs: false });
    expect(shownLast).toMatchObject({ bodyText: 'from them', direction: 'inbound' });
  });
});
