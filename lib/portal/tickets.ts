import { and, asc, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { Priority } from '@/lib/tickets/vocabulary';
import {
  agents,
  channels,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { afterInboundMessage, afterMessageStored } from '@/lib/tickets/lifecycle';
import { defaultOpenStatusId } from '@/lib/tickets/statuses';

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

/**
 * Read-only channels are excluded from all three of the queries below.
 *
 * The portal scopes by contact, and a customer bot transcript belongs to the
 * customer's own contact — so without this a customer who registers on the
 * portal sees their WhatsApp bot conversation in "my tickets" and can reply into
 * it. That is worse than it sounds: the reply lands in a mirror of somebody
 * else's conversation, and no agent is allowed to answer it, so the customer has
 * written into a thread nobody will ever read.
 */
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
        notInArray(conversations.channel, readOnlyChannels()),
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
        notInArray(conversations.channel, readOnlyChannels()),
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

export type NewTicket = {
  subject: string;
  body: string;
  customFields?: Record<string, unknown>;
  /**
   * What the form that opened this ticket presets on it.
   *
   * Defaults, not overrides: `afterInboundMessage` runs the on-create
   * automations immediately afterwards and those still win, because a rule is
   * the layer an admin uses to express something that spans forms. Undefined
   * means "no opinion" and leaves the channel's own default or the column's.
   */
  formId?: string | null;
  groupId?: string | null;
  priority?: Priority | null;
  type?: string | null;
  tags?: string[];
};

/**
 * The ids a caller needs after the ticket exists.
 *
 * The message id is here because attachments are owned by a message and are
 * uploaded after the transaction commits — see `lib/forms/attachments.ts`.
 * Returning only the number would mean looking the message back up by
 * conversation and timestamp, which is a race with any other write.
 */
export type CreatedTicket = { number: number; conversationId: string; messageId: string };

/**
 * Opens a ticket from the portal or from a form.
 *
 * Channel `portal` rather than `email`: it did not arrive by mail and has no
 * Message-ID, so filing it as email would put it in reporting's email column
 * and leave the threading code looking for a header that was never there.
 */
export async function createTicket(contactId: string, input: NewTicket): Promise<CreatedTicket> {
  const now = new Date();
  const portal = await portalChannel();

  const created = await db.transaction(async (tx) => {
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
        // The form's group first, then the channel's. Worth noting the second
        // is usually null: no `channels` row is seeded for `portal`, so before
        // forms existed a portal ticket reached the inbox with no group at all.
        groupId: input.groupId ?? portal?.defaultGroupId ?? null,
        formId: input.formId ?? null,
        // `undefined` rather than null where the caller has no opinion, so
        // Drizzle omits the column and the schema default applies.
        priority: input.priority ?? undefined,
        type: input.type ?? null,
        tags: input.tags ?? [],
        // Parsed and required-checked by the action before it gets here, against
        // the field definitions read from the database rather than from the form.
        customFields: input.customFields ?? {},
        lastMessageAt: now,
        lastCustomerMessageAt: now,
      })
      .returning({ id: conversations.id, number: conversations.number });

    const row = inserted[0]!;

    const insertedMessage = await tx
      .insert(messages)
      .values({
        conversationId: row.id,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: input.body,
        deliveryStatus: 'delivered',
        deliveredAt: now,
        createdAt: now,
      })
      .returning({ id: messages.id });

    return { id: row.id, number: row.number, messageId: insertedMessage[0]!.id };
  });

  await afterMessageStored({
    conversationId: created.id,
    messageId: created.messageId,
    bodyText: input.body,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(created.id, true, now);

  return { number: created.number, conversationId: created.id, messageId: created.messageId };
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
          notInArray(conversations.channel, readOnlyChannels()),
        ),
      )
      .limit(1);

    const ticket = rows[0];
    if (!ticket || ticket.statusCategory === 'closed') return null;

    if (ticket.statusCategory === 'resolved') {
      const reopenTo = await defaultOpenStatusId(tx);
      if (reopenTo) {
        const reopened = await tx
          .update(conversations)
          .set({ statusId: reopenTo, resolvedAt: null, reopenCount: ticket.reopenCount + 1 })
          .where(eq(conversations.id, ticket.id))
          .returning({ resolvedBy: conversations.resolvedByAgentId });

        await tx.insert(conversationEvents).values({
          conversationId: ticket.id,
          type: 'reopened',
          actorLabel: 'portal',
          data: { reason: 'customer_replied', resolvedBy: reopened[0]?.resolvedBy ?? null },
        });
      }
    }

    const insertedMessage = await tx
      .insert(messages)
      .values({
        conversationId: ticket.id,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: body,
        deliveryStatus: 'delivered',
        deliveredAt: now,
        createdAt: now,
      })
      .returning({ id: messages.id });

    await tx
      .update(conversations)
      .set({ lastMessageAt: now, lastCustomerMessageAt: now })
      .where(eq(conversations.id, ticket.id));

    return { id: ticket.id, messageId: insertedMessage[0]!.id };
  });

  if (!result) return { ok: false };

  await afterMessageStored({
    conversationId: result.id,
    messageId: result.messageId,
    bodyText: body,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(result.id, false, now);
  return { ok: true };
}

async function portalChannel() {
  const rows = await db
    .select({ id: channels.id, defaultGroupId: channels.defaultGroupId })
    .from(channels)
    .where(and(eq(channels.type, 'portal'), eq(channels.isActive, true)))
    .limit(1);

  return rows[0] ?? null;
}
