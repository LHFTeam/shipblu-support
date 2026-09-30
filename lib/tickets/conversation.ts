import { and, asc, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  conversationEvents,
  conversations,
  contacts,
  groups,
  messages,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { formName } from '@/lib/forms/naming';
import type { SessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { configuredAccountId } from '@/lib/meta/client';
import { metaConnection } from '@/lib/meta/connection';
import { metaThreadStateFromMessage, type MetaThreadState } from '@/lib/meta/thread';
import type { CustomFieldValues } from './custom-fields';
import { threadControlTakenAt } from './meta-thread';
import { hiddenChannels } from './channel-policy';
import {
  shipmentsForConversation,
  shippingAccountsForConversation,
  type LinkedShipment,
  type LinkedShippingAccount,
} from '@/lib/shipments/queries';
import { type AssignedCategory, categoriesForConversation } from '@/lib/categorise/queries';
import {
  sideConversationsForConversation,
  type SideConversationView,
} from '@/lib/side-conversations/queries';

export type TimelineMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  kind: 'reply' | 'note' | 'system' | 'forward';
  bodyHtml: string | null;
  bodyText: string;
  authorName: string | null;
  authorIsAgent: boolean;
  deliveryStatus: string;
  deliveryError: string | null;
  createdAt: Date;
  meta: Record<string, unknown>;
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[];
};

export type ConversationDetail = {
  id: string;
  number: number;
  subject: string | null;
  channel: string;
  priority: string;
  type: string | null;
  statusId: string;
  statusName: string;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  tags: string[];
  /**
   * Values for the admin-defined ticket fields, keyed by the field's `key` —
   * the same map `custom.<key>` conditions are evaluated against.
   */
  customFields: CustomFieldValues;
  assigneeAgentId: string | null;
  assigneeName: string | null;
  groupId: string | null;
  groupName: string | null;
  requester: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    /** Whether a profile picture is on file, so the header can skip a 404. */
    hasAvatar: boolean;
  };
  lastCustomerMessageAt: Date | null;
  createdAt: Date;
  reopenCount: number;
  /**
   * Whether a Facebook or Instagram reply can be delivered at all — which is a
   * separate question from whether the messaging window is still open, and the
   * one the composer had no way to ask. Null on every other channel.
   */
  metaThread: MetaThreadState | null;
  /**
   * Set for tickets that came from somewhere with its own identifier — today
   * that is a Facebook or Instagram comment thread, keyed on its root comment,
   * which is what tells the composer to write in public rather than in private.
   */
  externalId: string | null;
  /**
   * The form this ticket was submitted through, when it was.
   *
   * The name rather than the id, because the only thing the header does with it
   * is say it. Null covers both "no form" and "the form has since been deleted",
   * which read the same on screen and should: the ticket is still a ticket.
   */
  formName: string | null;
  /**
   * True when the ticket was opened by somebody who was not signed in.
   *
   * Read off the `unverified_submitter` event rather than stored as a column:
   * the event already carries the claimed address and the client address for
   * anybody investigating, and a boolean beside it would be a second copy of
   * one fact that could disagree with the first.
   */
  unverifiedSubmitter: boolean;
  /**
   * What this ticket is about, and why it happened.
   *
   * Loaded here rather than by the sidebar because the resolve control needs the
   * cause in the same render as the composer: an agent told they must record a
   * cause, by a page that has not loaded which one is set, would be told to fill
   * in something already filled in.
   */
  categories: AssignedCategory[];
  rootCauseId: string | null;
  /**
   * Which population asked, when the records established it.
   *
   * Only used to *order* the category picker — a merchant's payout question
   * offered first on a merchant's ticket. Never to filter: the value is
   * established from role flags that can be stale or absent, and a picker that
   * hides `billing.payout` from a ticket this got wrong is a control an agent
   * cannot work around.
   */
  requesterKind: 'merchant' | 'recipient' | 'prospect' | 'other' | null;
  /** Parcels this ticket is about, and the accounts it names. */
  shipments: LinkedShipment[];
  shippingAccounts: LinkedShippingAccount[];
  /**
   * Threads with hubs and other internal teams, hanging off this ticket.
   *
   * Loaded here rather than by the view because the timeline interleaves them
   * with messages: "the customer complained, we asked the hub, the hub answered,
   * we replied" only reads correctly in one ordered list.
   */
  sideConversations: SideConversationView[];
  messages: TimelineMessage[];
  events: {
    id: string;
    type: string;
    actorName: string | null;
    data: Record<string, unknown>;
    createdAt: Date;
  }[];
};

export async function getConversation(
  agent: SessionAgent,
  number: number,
): Promise<ConversationDetail | null> {
  const where = [eq(conversations.number, number), isNull(conversations.deletedAt)];
  if (!can(agent, 'ticket.view.all')) {
    where.push(eq(conversations.assigneeAgentId, agent.id));
  }

  // In the query, not after it: a ticket the agent may not see must not be
  // loaded and then hidden, or reachable by typing its number into the URL.
  const hidden = hiddenChannels(agent);
  if (hidden.length) where.push(notInArray(conversations.channel, hidden));

  const rows = await db
    .select({
      conversation: conversations,
      statusName: ticketStatuses.name,
      statusCategory: ticketStatuses.category,
      requesterId: contacts.id,
      requesterName: contacts.name,
      requesterEmail: contacts.primaryEmail,
      requesterPhone: contacts.primaryPhone,
      requesterAvatarPath: contacts.avatarPath,
      assigneeName: agents.name,
      groupName: groups.name,
      formNameAr: ticketForms.nameAr,
      formNameEn: ticketForms.nameEn,
      formSlug: ticketForms.slug,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .leftJoin(groups, eq(groups.id, conversations.groupId))
    .leftJoin(ticketForms, eq(ticketForms.id, conversations.formId))
    .where(and(...where))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  /**
   * Asked directly rather than read off the activity list below.
   *
   * That list is `limit(50)` newest-first and this event is always the oldest on
   * the ticket — it is written the moment the ticket is created. Deriving the
   * badge from it meant the "nobody proved who sent this" warning disappeared
   * once fifty things had happened, which is exactly the escalated ticket where
   * an agent most needs it.
   */
  const unverified = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, row.conversation.id),
        eq(conversationEvents.type, 'unverified_submitter'),
      ),
    )
    .limit(1);
  const unverifiedSubmitter = unverified.length > 0;

  const [timeline, files, events, shipments, accounts, sides, categories, controlTakenAt] =
    await Promise.all([
      db
        .select({
          message: messages,
          agentName: agents.name,
          contactName: contacts.name,
        })
        .from(messages)
        .leftJoin(agents, eq(agents.id, messages.authorAgentId))
        .leftJoin(contacts, eq(contacts.id, messages.authorContactId))
        .where(eq(messages.conversationId, row.conversation.id))
        // The id settles two messages stamped with the same instant — a batch
        // sharing one `now`, or a provider's second-precision `sentAt` — so the
        // timeline's last message is the one the inbox card previews
        // (`lastVisibleMessage` in lib/tickets/inbox.ts breaks the tie the same
        // way). Without it Postgres returns equal rows in whatever order it likes.
        .orderBy(asc(messages.createdAt), asc(messages.id)),

      db
        .select({
          id: attachments.id,
          messageId: attachments.messageId,
          filename: attachments.filename,
          contentType: attachments.contentType,
          sizeBytes: attachments.sizeBytes,
        })
        .from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(eq(messages.conversationId, row.conversation.id)),

      db
        .select({
          id: conversationEvents.id,
          type: conversationEvents.type,
          actorName: agents.name,
          actorLabel: conversationEvents.actorLabel,
          data: conversationEvents.data,
          createdAt: conversationEvents.createdAt,
        })
        .from(conversationEvents)
        .leftJoin(agents, eq(agents.id, conversationEvents.actorAgentId))
        .where(eq(conversationEvents.conversationId, row.conversation.id))
        .orderBy(desc(conversationEvents.createdAt))
        .limit(50),

      shipmentsForConversation(row.conversation.id, row.conversation.requesterContactId),
      shippingAccountsForConversation(row.conversation.id),
      sideConversationsForConversation(row.conversation.id),
      categoriesForConversation(row.conversation.id),
      threadControlTakenAt(row.conversation.id),
    ]);

  const filesByMessage = new Map<string, ConversationDetail['messages'][number]['attachments']>();
  for (const file of files) {
    // `messageId` is nullable since attachments also hang off side conversation
    // messages; the join above already restricts this query to ticket ones, so
    // this is a type narrowing rather than a filter.
    if (!file.messageId) continue;
    const list = filesByMessage.get(file.messageId) ?? [];
    list.push({
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    });
    filesByMessage.set(file.messageId, list);
  }

  /*
    Derived from the timeline that was just loaded rather than from a query of
    its own: the composer's verdict has to describe the same last message the
    agent is looking at, and a second read could catch a newer one.

    A comment ticket is left out. It is answered through the comment endpoints,
    which are addressed by comment id and are not page-scoped, so neither of the
    two refusals applies to it.
  */
  const isMeta =
    row.conversation.channel === 'facebook' || row.conversation.channel === 'instagram';
  const isCommentThread = Boolean(row.conversation.externalId?.includes(':comment:'));

  let metaThread: MetaThreadState | null = null;
  if (isMeta && !isCommentThread) {
    const platform = row.conversation.channel as 'facebook' | 'instagram';
    const lastInbound = timeline.filter((entry) => entry.message.direction === 'inbound').at(-1);

    metaThread = metaThreadStateFromMessage({
      platform,
      connection: metaConnection(platform),
      configuredAccountId: configuredAccountId(platform),
      lastInboundMeta: (lastInbound?.message.meta ?? null) as Record<string, unknown> | null,
      // The one part not taken off the loaded timeline, because the events list
      // above is capped at fifty and this is the fact whose absence silently
      // re-refuses every reply on the ticket.
      lastInboundAt: lastInbound?.message.createdAt ?? null,
      controlTakenAt,
    });
  }

  return {
    id: row.conversation.id,
    number: row.conversation.number,
    subject: row.conversation.subject,
    channel: row.conversation.channel,
    externalId: row.conversation.externalId,
    formName: row.formSlug
      ? formName({ nameAr: row.formNameAr!, nameEn: row.formNameEn!, slug: row.formSlug }, 'en')
      : null,
    unverifiedSubmitter,
    metaThread,
    categories,
    rootCauseId: row.conversation.rootCauseId,
    requesterKind: row.conversation.requesterKind,
    shipments,
    shippingAccounts: accounts,
    sideConversations: sides,
    priority: row.conversation.priority,
    type: row.conversation.type,
    statusId: row.conversation.statusId,
    statusName: row.statusName,
    statusCategory: row.statusCategory,
    tags: row.conversation.tags,
    customFields: row.conversation.customFields,
    assigneeAgentId: row.conversation.assigneeAgentId,
    assigneeName: row.assigneeName,
    groupId: row.conversation.groupId,
    groupName: row.groupName,
    requester: {
      id: row.requesterId,
      name: row.requesterName,
      email: row.requesterEmail,
      phone: row.requesterPhone,
      hasAvatar: row.requesterAvatarPath !== null,
    },
    lastCustomerMessageAt: row.conversation.lastCustomerMessageAt,
    createdAt: row.conversation.createdAt,
    reopenCount: row.conversation.reopenCount,
    messages: timeline.map((entry) => ({
      id: entry.message.id,
      direction: entry.message.direction,
      kind: entry.message.kind,
      bodyHtml: entry.message.bodyHtml,
      bodyText: entry.message.bodyText,
      authorName: entry.agentName ?? entry.contactName,
      authorIsAgent: entry.message.authorAgentId !== null,
      deliveryStatus: entry.message.deliveryStatus,
      deliveryError: entry.message.deliveryError,
      createdAt: entry.message.createdAt,
      meta: entry.message.meta,
      attachments: filesByMessage.get(entry.message.id) ?? [],
    })),
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      actorName: event.actorName ?? event.actorLabel,
      data: event.data,
      createdAt: event.createdAt,
    })),
  };
}
