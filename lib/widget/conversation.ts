import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { normaliseEmail } from '@/lib/auth/normalise';
import { preview } from '@/lib/html/sanitize';
import { afterInboundMessage, afterMessageStored } from '@/lib/tickets/lifecycle';
import { recordIdentityOnConversation } from './identify';
import { findLiveConversation, webchatChannel } from './session';

/**
 * Reading and appending to a visitor's chat.
 *
 * Everything here is reached from unauthenticated endpoints, so every function
 * takes the contact the visitor's token resolved to and scopes its query by it.
 * None of them accept a conversation id from the caller — that would let a
 * visitor read someone else's chat by guessing.
 */

export type WidgetMessage = {
  id: string;
  from: 'visitor' | 'agent' | 'system';
  authorName: string | null;
  body: string;
  createdAt: string;
};

/** Private notes are excluded here, not filtered in the UI. */
export async function listMessages(conversationId: string): Promise<WidgetMessage[]> {
  const rows = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      kind: messages.kind,
      bodyText: messages.bodyText,
      createdAt: messages.createdAt,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        // An agent-only note must never reach the widget. Excluding it in the
        // query rather than in the renderer means it is not in the payload at
        // all, so it cannot leak through a devtools panel either.
        eq(messages.kind, 'reply'),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(200);

  return rows.map((row) => ({
    id: row.id,
    from: row.direction === 'inbound' ? 'visitor' : row.agentName ? 'agent' : 'system',
    authorName: row.agentName,
    body: row.bodyText,
    createdAt: row.createdAt.toISOString(),
  }));
}

export type AppendResult = {
  conversationId: string;
  messageId: string;
  createdConversation: boolean;
};

/**
 * Appends a visitor message, opening a conversation if there is not a live one.
 *
 * `lastCustomerMessageAt` is set for consistency with the other channels even
 * though webchat has no 24-hour window — the SLA clock reads it, and leaving it
 * null would make chat conversations look permanently unanswered.
 */
export async function appendVisitorMessage(
  contactId: string,
  body: string,
  meta: { pageUrl?: string | null; userAgent?: string | null } = {},
): Promise<AppendResult> {
  const existing = await findLiveConversation(contactId);
  const channel = await webchatChannel();
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    let conversationId = existing;
    let createdConversation = false;

    if (!conversationId) {
      const statusId = await defaultOpenStatusId(tx);
      if (!statusId) {
        throw new Error('No default open ticket status configured — run `npm run db:seed`');
      }

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: 'webchat',
          channelId: channel?.id ?? null,
          statusId,
          // Chat has no subject line; the first message is the most useful
          // thing to show in a ticket list.
          subject: preview(body, 80) || 'Web chat',
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          lastMessageAt: now,
          lastCustomerMessageAt: now,
        })
        .returning({ id: conversations.id });

      conversationId = inserted[0]!.id;
      createdConversation = true;
    } else {
      const reopened = await reopenIfResolved(tx, conversationId);
      if (reopened) {
        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'reopened',
          actorLabel: 'webchat',
          // Snapshotted rather than read back at report time: the column it
          // came from is overwritten by the next resolution, and the rollup
          // rebuilds recent days.
          data: { reason: 'visitor_replied', resolvedBy: reopened.resolvedBy },
        });
      }
    }

    const inserted = await tx
      .insert(messages)
      .values({
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: body,
        deliveryStatus: 'delivered',
        deliveredAt: now,
        meta: { pageUrl: meta.pageUrl ?? null, userAgent: meta.userAgent ?? null },
        createdAt: now,
      })
      .returning({ id: messages.id });

    await tx
      .update(conversations)
      .set({ lastMessageAt: now, lastCustomerMessageAt: now })
      .where(eq(conversations.id, conversationId));

    return { conversationId, messageId: inserted[0]!.id, createdConversation };
  });

  /*
   * Before the automations, so a rule routing on the merchant's account sees the
   * link rather than racing it. Only on creation: an identity that changes under
   * a live conversation is recorded by the identify endpoint itself, and doing
   * it per message would write the same event onto every reply.
   */
  if (result.createdConversation) {
    await recordIdentityOnConversation(result.conversationId, contactId);
  }

  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: body,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, now);

  return result;
}

/** Records the email a visitor leaves when nobody is available. */
export async function attachVisitorEmail(
  contactId: string,
  conversationId: string,
  email: string,
  name: string | null,
): Promise<void> {
  const address = normaliseEmail(email);

  await db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set({ primaryEmail: address, ...(name ? { name } : {}) })
      .where(eq(contacts.id, contactId));

    // Links the address to the same contact, so their later email lands on this
    // history instead of opening a second customer record. Conflict means the
    // address already belongs to someone — left alone rather than reassigned,
    // because merging two customers is a decision for an agent.
    await tx
      .insert(contactIdentities)
      .values({ contactId, channel: 'email', identifier: address, displayName: name })
      .onConflictDoNothing({
        target: [contactIdentities.channel, contactIdentities.identifier],
      });

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'contact_updated',
      actorLabel: 'webchat',
      data: { email: address },
    });
  });
}

/**
 * Reopen a resolved conversation, reporting who had resolved it.
 *
 * Returns null when there was nothing to reopen. The resolver comes back with
 * it because the caller writes the timeline event and needs to stamp it there —
 * `resolved_by_agent_id` is overwritten by the next resolution, so a reader
 * looking it up later would attribute this reopening to the wrong person.
 */
async function reopenIfResolved(
  tx: typeof db,
  conversationId: string,
): Promise<{ resolvedBy: string | null } | null> {
  const rows = await tx
    .select({ category: ticketStatuses.category, reopenCount: conversations.reopenCount })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (rows[0]?.category !== 'resolved') return null;

  const statusId = await defaultOpenStatusId(tx);
  if (!statusId) return null;

  // `resolvedByAgentId` is left untouched by this update, so returning it tells
  // the caller who resolved the ticket this reply is reopening.
  const reopened = await tx
    .update(conversations)
    .set({ statusId, resolvedAt: null, reopenCount: rows[0].reopenCount + 1 })
    .where(eq(conversations.id, conversationId))
    .returning({ resolvedBy: conversations.resolvedByAgentId });

  return { resolvedBy: reopened[0]?.resolvedBy ?? null };
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
