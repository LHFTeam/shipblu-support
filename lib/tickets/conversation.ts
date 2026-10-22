import { and, asc, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  channels,
  conversationEvents,
  conversations,
  contacts,
  groups,
  messages,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { allLimited } from '@/lib/concurrency';
import { formName } from '@/lib/forms/naming';
import { suppressedBy, ticketSurveyState, type TicketSurveyState } from '@/lib/csat';
import type { SuppressedBy } from '@/lib/csat/decision';
import type { SessionAgent } from '@/lib/auth/session';
import { configuredAccountId } from '@/lib/meta/client';
import { metaConnection } from '@/lib/meta/connection';
import { metaThreadStateFromMessage, type MetaThreadState } from '@/lib/meta/thread';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import type { CustomFieldValues } from './custom-fields';
import { threadControlTakenAt } from './meta-thread';
import {
  hiddenChannels,
  isCommentTicket,
  isMetaChannel,
  metaPlatformOf,
  type ConversationChannel,
} from './channel-policy';
import { assignmentVisibility } from './visibility';
import { metaIndex } from './message-media';
import {
  foldReactions,
  type PlacedReaction,
  type ShownReaction,
  storedReaction,
} from './reactions';
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
  /**
   * The contact who wrote it, when a contact did — not the requester. An
   * inbound email on a ticket can be a CC'd stranger, and the requester's
   * picture on their words would be a claim about who wrote them.
   */
  authorContactId: string | null;
  /** Whether that contact has a picture on file, so the tile can skip a 404. */
  authorContactHasAvatar: boolean;
  /** The writing agent's tile colour and picture, as the inbox list draws them. */
  authorAgentColor: string | null;
  authorAgentAvatarUrl: string | null;
  deliveryStatus: string;
  deliveryError: string | null;
  createdAt: Date;
  meta: Record<string, unknown>;
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[];
  /**
   * Set when this row is a reaction rather than something anybody said — the
   * emoji (empty when the reactor took theirs back, null when its payload could
   * not be read) and the message it is about, null when that message is not on
   * this ticket. `lib/tickets/reactions.ts`.
   */
  reaction: PlacedReaction | null;
  /** The reactions this message carries now, each naming the row it came from. */
  reactions: ShownReaction[];
};

export type ConversationDetail = {
  id: string;
  number: number;
  subject: string | null;
  channel: ConversationChannel;
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
  /**
   * Whose SLA breaches this ticket counts against: the owner of the WhatsApp
   * number it arrived on, frozen onto the ticket when it was opened, handed
   * over or reopened after a handover. Null is "whoever holds it", which is
   * every ticket not on an owned number — the same fallback the reports take
   * (`accountableOrAssignee` in lib/tickets/accountable.ts).
   *
   * `active` because a deactivated owner keeps the tickets they had until an
   * admin hands the number over, and the sidebar has to say so rather than
   * show a name nobody can sign in as.
   */
  accountable: { id: string; name: string; active: boolean } | null;
  /**
   * Which of our WhatsApp numbers the ticket is on, for a `whatsapp` or
   * `whatsapp_bot` ticket that carries a `channel_id`; null otherwise,
   * including the few old tickets filed before a ticket knew its number.
   *
   * A customer who writes to two of our numbers has two tickets, one per
   * number, and nothing else on the page tells them apart — the requester,
   * the channel badge and the subject are the same on both.
   *
   * Built from named fields rather than the row: `channels.config` holds the
   * number's Meta ids and its onboarding state, and this object is serialised
   * into the page's RSC payload. `displayNumber` is the number Meta reported
   * for a coexistence number and null for a plain one, whose config holds only
   * the `phoneNumberId` — a Meta id, which is not a phone number and would be
   * misread as one.
   *
   * `owner` is the number's owner *now*, which can differ from `accountable`:
   * a resolved ticket from before a handover, a ticket opened while the owner
   * was deactivated, the copied history. The sidebar says which it is.
   */
  businessNumber: {
    name: string;
    displayNumber: string | null;
    owner: { id: string; name: string; active: boolean } | null;
  } | null;
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
  /** Who asked that this ticket not be surveyed, an agent or a rule; null when nobody did. */
  csatSuppressedBy: SuppressedBy | null;
  /**
   * Spam, or merged into another ticket: the survey job drops it and writes
   * nothing, so a "Send now" there would wait for an answer that never comes.
   */
  surveyDropped: boolean;
  /** The ticket's newest survey, and a later decision not to send one, for the sidebar. */
  survey: TicketSurveyState;
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
  const assignment = assignmentVisibility(agent);
  if (assignment) where.push(assignment);

  // In the query, not after it: a ticket the agent may not see must not be
  // loaded and then hidden, or reachable by typing its number into the URL.
  const hidden = hiddenChannels(agent);
  if (hidden.length) where.push(notInArray(conversations.channel, hidden));

  // Two more readings of `agents` beside the assignee's: the ticket's
  // accountable agent and the number's current owner, who are the same person
  // on most owned tickets and not on the ones the sidebar has to explain.
  const accountableAgent = alias(agents, 'accountable_agent');
  const numberOwner = alias(agents, 'number_owner');

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
      accountableId: accountableAgent.id,
      accountableName: accountableAgent.name,
      accountableActive: accountableAgent.isActive,
      numberName: channels.name,
      numberConfig: channels.config,
      ownerId: numberOwner.id,
      ownerName: numberOwner.name,
      ownerActive: numberOwner.isActive,
      groupName: groups.name,
      formNameAr: ticketForms.nameAr,
      formNameEn: ticketForms.nameEn,
      formSlug: ticketForms.slug,
      csatSuppressedBy: suppressedBy(),
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .leftJoin(accountableAgent, eq(accountableAgent.id, conversations.accountableAgentId))
    // Only a WhatsApp row is one of our numbers. Another kind of ticket can
    // carry a `channel_id` too, naming a mailbox or a widget, and the header
    // would otherwise call that a number.
    .leftJoin(
      channels,
      and(
        eq(channels.id, conversations.channelId),
        inArray(channels.type, ['whatsapp', 'whatsapp_bot']),
      ),
    )
    .leftJoin(numberOwner, eq(numberOwner.id, channels.ownerAgentId))
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

  const [timeline, files, events, shipments, accounts, sides, categories, controlTakenAt, survey] =
    // Nine reads on a pool of eight places: at most the pool at once, so one
    // ticket page can fill it but never queue behind itself (AGENTS.md,
    // Database) — one wave, as before, plus the ninth.
    await allLimited(8, [
      () =>
        db
          .select({
            message: messages,
            agentName: agents.name,
            agentColor: agents.avatarColor,
            agentAvatarUrl: agents.avatarUrl,
            contactName: contacts.name,
            contactAvatarPath: contacts.avatarPath,
            contactDeletedAt: contacts.deletedAt,
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

      () =>
        db
          .select({
            id: attachments.id,
            messageId: attachments.messageId,
            filename: attachments.filename,
            contentType: attachments.contentType,
            sizeBytes: attachments.sizeBytes,
            contentId: attachments.contentId,
          })
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .where(eq(messages.conversationId, row.conversation.id))
          // The thread draws a message's pictures one under another, so an order
          // Postgres is free to change between two renders would shuffle them on
          // a live update. Stored order is the order an email's parts were in;
          // a Messenger album is put in its sender's order below.
          .orderBy(asc(attachments.createdAt), asc(attachments.id)),

      () =>
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

      () => shipmentsForConversation(row.conversation.id, row.conversation.requesterContactId),
      () => shippingAccountsForConversation(row.conversation.id),
      () => sideConversationsForConversation(row.conversation.id),
      () => categoriesForConversation(row.conversation.id),
      () => threadControlTakenAt(row.conversation.id),
      () => ticketSurveyState(row.conversation.id, row.conversation.channel),
    ]);

  // Paired here rather than in the browser: the target is only named in the
  // stored delivery, and `raw_body` is not something to ship to the client for
  // every message of a long ticket.
  const reactions = foldReactions(
    timeline.map((entry) => ({
      id: entry.message.id,
      direction: entry.message.direction,
      authorContactId: entry.message.authorContactId,
      channelMessageId: entry.message.channelMessageId,
      reaction: storedReaction(entry.message.meta, entry.message.rawBody),
    })),
  );

  // Each of a Messenger album's files is fetched by a job of its own, and the
  // jobs finish in whatever order they finish, so the order they were stored in
  // is not the order the customer sent them — before, after, the label. The
  // index each was sent at is on the row. A stable sort, and every other file
  // compares equal, so an email keeps its parts' order.
  const sent = (file: (typeof files)[number]) =>
    metaIndex(file.contentId) ?? Number.MAX_SAFE_INTEGER;
  files.sort((a, b) => sent(a) - sent(b));

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

    A comment ticket is left out — by its channel, or by its external id while
    it still carries its platform's. It is answered through the comment
    endpoints, which are addressed by comment id and are not page-scoped, so
    neither of the two refusals applies to it.
  */
  const channel = row.conversation.channel;
  const isCommentThread = isCommentTicket(channel, row.conversation.externalId);

  let metaThread: MetaThreadState | null = null;
  if (isMetaChannel(channel) && !isCommentThread) {
    const platform = metaPlatformOf(channel);
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
    accountable: row.accountableId
      ? { id: row.accountableId, name: row.accountableName!, active: row.accountableActive! }
      : null,
    businessNumber:
      row.numberName !== null
        ? {
            name: row.numberName,
            displayNumber: parseCoexistence(row.numberConfig)?.displayPhoneNumber ?? null,
            owner: row.ownerId
              ? { id: row.ownerId, name: row.ownerName!, active: row.ownerActive! }
              : null,
          }
        : null,
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
    csatSuppressedBy: row.csatSuppressedBy,
    surveyDropped: row.conversation.isSpam || row.conversation.mergedIntoId !== null,
    survey,
    messages: timeline.map((entry) => ({
      id: entry.message.id,
      direction: entry.message.direction,
      kind: entry.message.kind,
      bodyHtml: entry.message.bodyHtml,
      bodyText: entry.message.bodyText,
      authorName: entry.agentName ?? entry.contactName,
      authorIsAgent: entry.message.authorAgentId !== null,
      authorContactId: entry.message.authorContactId,
      // The avatar route answers 404 for a deleted contact, so a picture left
      // on its row is not one the tile can show.
      authorContactHasAvatar: entry.contactAvatarPath !== null && entry.contactDeletedAt === null,
      authorAgentColor: entry.agentColor,
      authorAgentAvatarUrl: entry.agentAvatarUrl,
      deliveryStatus: entry.message.deliveryStatus,
      deliveryError: entry.message.deliveryError,
      createdAt: entry.message.createdAt,
      meta: entry.message.meta,
      attachments: filesByMessage.get(entry.message.id) ?? [],
      reaction: reactions.rows.get(entry.message.id) ?? null,
      reactions: reactions.shown.get(entry.message.id) ?? [],
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
