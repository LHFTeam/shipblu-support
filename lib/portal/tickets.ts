import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { preview } from '@/lib/html/sanitize';
import { afterInboundMessage } from '@/lib/tickets/lifecycle';

/**
 * The customer's own view of their tickets.
 *
 * Every function here takes the contact id resolved from the session cookie and
 * scopes its query by it; none of them accept a conversation id on its own. A
 * ticket is addressed by its *number*, which is guessable, so the number is
 * always paired with the requester in the `where` clause — looking the ticket up
 * first and comparing afterwards is the same bug written more slowly.
 *
 * Private notes never leave the database: they are excluded in the query rather
 * than filtered in the renderer, so they are not in the payload to leak.
 */

export type PortalTicket = {
  number: number;
  subject: string | null;
  statusLabel: string | null;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  channel: string;
  lastMessageAt: Date;
  createdAt: Date;
};

export async function listTickets(contactId: string, limit = 100): Promise<PortalTicket[]> {
  return db
    .select({
      number: conversations.number,
      subject: conversations.subject,
      // The *customer* label only, never the status's own name. Null here means
      // the page falls back to a plain word for the category in the reader's
      // language — which is both safer ("Escalated to ops — tier 2" never
      // reaches a customer) and, on an Arabic help centre, more likely to be
      // readable, since `customer_label` is a single field with no translation.
      statusLabel: sql<
        string | null
      >`case when ${ticketStatuses.visibleToCustomer} then ${ticketStatuses.customerLabel} else null end`,
      statusCategory: ticketStatuses.category,
      channel: conversations.channel,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(
      and(
        eq(conversations.requesterContactId, contactId),
        isNull(conversations.deletedAt),
        isNull(conversations.mergedIntoId),
        eq(conversations.isSpam, false),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);
}

export type PortalMessage = {
  id: string;
  from: 'customer' | 'agent';
  authorName: string | null;
  body: string;
  createdAt: Date;
};

export type PortalTicketDetail = PortalTicket & {
  id: string;
  messages: PortalMessage[];
  /** False once the ticket is closed: a closed ticket needs a new one, not a reply. */
  canReply: boolean;
};

export async function getTicket(
  contactId: string,
  number: number,
): Promise<PortalTicketDetail | null> {
  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      subject: conversations.subject,
      statusLabel: sql<
        string | null
      >`case when ${ticketStatuses.visibleToCustomer} then ${ticketStatuses.customerLabel} else null end`,
      statusCategory: ticketStatuses.category,
      channel: conversations.channel,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(
      and(
        eq(conversations.number, number),
        eq(conversations.requesterContactId, contactId),
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
      ),
    )
    .limit(1);

  const ticket = rows[0];
  if (!ticket) return null;

  const timeline = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      bodyText: messages.bodyText,
      createdAt: messages.createdAt,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.conversationId, ticket.id), eq(messages.kind, 'reply')))
    .orderBy(asc(messages.createdAt))
    .limit(200);

  return {
    ...ticket,
    messages: timeline.map((row) => ({
      id: row.id,
      from: row.direction === 'inbound' ? 'customer' : 'agent',
      authorName: row.agentName,
      body: row.bodyText,
      createdAt: row.createdAt,
    })),
    canReply: ticket.statusCategory !== 'closed',
  };
}

/**
 * Opens a ticket from the portal.
 *
 * Channel `portal` rather than `email`: it did not arrive by mail and has no
 * Message-ID, so filing it as email would put it in reporting's email column
 * and leave the threading code looking for a header that was never there.
 */
export async function createTicket(
  contactId: string,
  input: { subject: string; body: string },
): Promise<number> {
  const now = new Date();
  const portal = await portalChannel();

  const conversationId = await db.transaction(async (tx) => {
    const statusId = await defaultOpenStatusId(tx);
    if (!statusId) {
      throw new Error('No default open ticket status configured — run `npm run db:seed`');
    }

    const inserted = await tx
      .insert(conversations)
      .values({
        channel: 'portal',
        channelId: portal?.id ?? null,
        statusId,
        subject: input.subject,
        requesterContactId: contactId,
        groupId: portal?.defaultGroupId ?? null,
        lastMessageAt: now,
        lastCustomerMessageAt: now,
      })
      .returning({ id: conversations.id });

    const id = inserted[0]!.id;

    await tx.insert(messages).values({
      conversationId: id,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: contactId,
      bodyText: input.body,
      deliveryStatus: 'delivered',
      deliveredAt: now,
      createdAt: now,
    });

    return id;
  });

  await afterInboundMessage(conversationId, true, now);

  const rows = await db
    .select({ number: conversations.number })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  return rows[0]!.number;
}

export type ReplyResult = { ok: true } | { ok: false };

/**
 * Appends a customer reply to one of their own tickets.
 *
 * Recorded as `inbound`, whatever channel the ticket arrived on: the customer
 * said it, so it counts as a customer response for the SLA clock and reopens a
 * resolved ticket exactly as an emailed reply would. The agent's answer still
 * goes back out over the ticket's own channel from the console.
 */
export async function appendReply(
  contactId: string,
  number: number,
  body: string,
): Promise<ReplyResult> {
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: conversations.id,
        statusCategory: ticketStatuses.category,
        reopenCount: conversations.reopenCount,
      })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
      .where(
        and(
          eq(conversations.number, number),
          eq(conversations.requesterContactId, contactId),
          isNull(conversations.deletedAt),
          eq(conversations.isSpam, false),
        ),
      )
      .limit(1);

    const ticket = rows[0];
    if (!ticket || ticket.statusCategory === 'closed') return null;

    if (ticket.statusCategory === 'resolved') {
      const reopenTo = await defaultOpenStatusId(tx);
      if (reopenTo) {
        await tx
          .update(conversations)
          .set({ statusId: reopenTo, resolvedAt: null, reopenCount: ticket.reopenCount + 1 })
          .where(eq(conversations.id, ticket.id));

        await tx.insert(conversationEvents).values({
          conversationId: ticket.id,
          type: 'reopened',
          actorLabel: 'portal',
          data: { reason: 'customer_replied' },
        });
      }
    }

    await tx.insert(messages).values({
      conversationId: ticket.id,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: contactId,
      bodyText: body,
      deliveryStatus: 'delivered',
      deliveredAt: now,
      createdAt: now,
    });

    await tx
      .update(conversations)
      .set({ lastMessageAt: now, lastCustomerMessageAt: now })
      .where(eq(conversations.id, ticket.id));

    return ticket.id;
  });

  if (!result) return { ok: false };

  await afterInboundMessage(result, false, now);
  return { ok: true };
}

/** Display name for the person who is signed in, for the header. */
export async function contactName(contactId: string): Promise<string | null> {
  const rows = await db
    .select({ name: contacts.name })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/** Subject line for a ticket opened from the portal, when none was given. */
export function subjectFrom(body: string): string {
  return preview(body, 80) || 'Support request';
}

async function portalChannel() {
  const rows = await db
    .select({ id: channels.id, defaultGroupId: channels.defaultGroupId })
    .from(channels)
    .where(and(eq(channels.type, 'portal'), eq(channels.isActive, true)))
    .limit(1);

  return rows[0] ?? null;
}

async function defaultOpenStatusId(tx: typeof db): Promise<string | null> {
  const preferred = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.category, 'open'), eq(ticketStatuses.isDefault, true)))
    .limit(1);

  if (preferred[0]) return preferred[0].id;

  const fallback = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.category, 'open'))
    .orderBy(ticketStatuses.position)
    .limit(1);

  return fallback[0]?.id ?? null;
}
