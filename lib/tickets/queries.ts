import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  cannedResponses,
  conversationEvents,
  conversations,
  contacts,
  groupMembers,
  groups,
  messages,
  ticketFields,
  ticketForms,
  ticketStatuses,
  whatsappTemplates,
} from '@/db/schema';
import { formName } from '@/lib/forms/naming';
import type { SessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { configuredAccountId } from '@/lib/meta/client';
import { metaConnection } from '@/lib/meta/connection';
import { metaThreadStateFromMessage, type MetaThreadState } from '@/lib/meta/thread';
import type { CustomFieldValues, TicketFieldDef } from './custom-fields';
import {
  FILTERABLE_CHANNELS,
  hiddenChannels,
  restrictedChannels,
  type FilterableChannel,
} from './channel-policy';
import {
  sbidMatches,
  shipmentsForConversation,
  shippingAccountsForConversation,
  trackingMatches,
  type LinkedShipment,
  type LinkedShippingAccount,
  type ReadScope,
} from '@/lib/shipments/queries';
import {
  sideConversationsForConversation,
  type SideConversationView,
} from '@/lib/side-conversations/queries';
import { parseSearchTerm } from './search';

/**
 * Read models for the console.
 *
 * Kept apart from the write path so a page renders from one query per pane
 * rather than an ORM graph walk — the inbox is the most-loaded screen in the
 * product and the difference is visible.
 */

export type InboxFilters = {
  view: 'all' | 'mine' | 'unassigned';
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed' | 'all' | 'unresolved';
  channel: 'all' | 'email' | 'whatsapp' | 'webchat' | 'facebook' | 'instagram' | 'whatsapp_bot';
  q: string;
};

export const PAGE_SIZE = 30;

/**
 * Where a page of the inbox stops, as a keyset rather than an offset.
 *
 * The inbox is sorted by most recent activity and reorders itself constantly —
 * every inbound message moves a conversation to the top. Under `OFFSET 30` that
 * shuffling is silent corruption: rows pushed past the boundary between two
 * requests are served twice, and rows that move up are skipped entirely. An
 * agent scrolling a busy queue would see duplicates and, worse, never see the
 * tickets that slipped through the gap.
 *
 * A keyset asks for "older than this exact row" instead, which is stable no
 * matter what happens above it. Rows that move up are simply re-sorted into the
 * live first page, where the list dedupes them by id.
 *
 * `lastMessageAt` alone is not unique, so the row's id is carried as a
 * tiebreaker and both are compared as a tuple.
 */
export type InboxCursor = { time: string; id: string };

/**
 * The timestamp travels as the text Postgres printed rather than as a JS Date.
 *
 * `Date` holds milliseconds and `timestamptz` holds microseconds, so a cursor
 * that round-tripped through `Date` would compare against a value a few
 * microseconds earlier than the row it names — and the tuple comparison would
 * then hand back a row that has already been shown, or skip its neighbour.
 * Keeping the original text keeps the comparison exact.
 */
export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(`${cursor.time}|${cursor.id}`, 'utf8').toString('base64url');
}

export function parseInboxCursor(value: string | null | undefined): InboxCursor | null {
  if (!value) return null;

  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  // Split on the first separator only: the timestamp cannot contain one, but
  // refusing to guess keeps a malformed cursor from becoming a malformed query.
  const separator = decoded.indexOf('|');
  if (separator < 1) return null;

  const time = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!time || !UUID_PATTERN.test(id)) return null;

  return { time, id };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseFilters(params: Record<string, string | string[] | undefined>): InboxFilters {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const view = one('view');
  const statusCategory = one('status');
  const channel = one('channel');

  return {
    view: view === 'mine' || view === 'unassigned' ? view : 'all',
    statusCategory:
      statusCategory === 'open' ||
      statusCategory === 'pending' ||
      statusCategory === 'resolved' ||
      statusCategory === 'closed' ||
      statusCategory === 'all'
        ? statusCategory
        : 'unresolved',
    // Every value the dropdown offers has to be listed, or selecting it falls
    // through to 'all' and the filter silently does nothing.
    channel: FILTERABLE_CHANNELS.includes(channel as FilterableChannel)
      ? (channel as FilterableChannel)
      : 'all',
    q: (one('q') ?? '').trim(),
  };
}

export type InboxRow = {
  id: string;
  number: number;
  subject: string | null;
  channel: string;
  priority: string;
  statusName: string;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  requesterName: string | null;
  requesterHandle: string | null;
  assigneeName: string | null;
  lastMessageAt: Date;
  lastCustomerMessageAt: Date | null;
  tags: string[];
  preview: string | null;
  /**
   * Whether this ticket is blocked on, or has just heard back from, an internal
   * team.
   *
   * `replied` is the one an agent needs to see from the list: the hub has
   * answered and nobody has acted on it yet. Derived from the thread's own rows
   * rather than tracked per agent — a read receipt would be a table and a write
   * on every render, to decide the colour of a badge.
   */
  sideState: 'waiting' | 'replied' | null;
};

/**
 * Who may see which conversations, as SQL.
 *
 * Exported because the customer, account and shipment pages list conversations
 * too, and re-implementing this rule in four more files is how a bot transcript
 * eventually leaks through a side door. Visibility is enforced in the query and
 * never in the template: an agent who can only see their own tickets must not be
 * able to reach another's by URL, and filtering after the fact would still have
 * loaded the row.
 */
export function conversationVisibility(agent: SessionAgent): SQL[] {
  const where: SQL[] = [isNull(conversations.deletedAt), isNull(conversations.mergedIntoId)];

  if (!can(agent, 'ticket.view.all')) {
    where.push(eq(conversations.assigneeAgentId, agent.id));
  }

  const hidden = hiddenChannels(agent);
  if (hidden.length) where.push(notInArray(conversations.channel, hidden));

  return where;
}

/**
 * The same rule as `conversationVisibility`, in the shape the shipment read
 * model takes.
 *
 * `lib/shipments/queries.ts` deliberately knows nothing about agents — that is
 * the seam the future platform endpoint sits on — so the console has to say what
 * this agent may see. This is the one place that translation happens.
 */
export function scopeForAgent(agent: SessionAgent, overrides: ReadScope = {}): ReadScope {
  return {
    excludeChannels: hiddenChannels(agent),
    onlyAssigneeAgentId: can(agent, 'ticket.view.all') ? undefined : agent.id,
    includeClosed: true,
    ...overrides,
  };
}

export async function listInbox(
  agent: SessionAgent,
  filters: InboxFilters,
  cursor: InboxCursor | null = null,
): Promise<{ rows: InboxRow[]; nextCursor: string | null }> {
  const where = [isNull(conversations.deletedAt), isNull(conversations.mergedIntoId)];

  // Visibility is enforced in the query, not the template: an agent who can
  // only see their own tickets must not be able to reach another's by URL, and
  // filtering after the fact would still have loaded the row.
  if (!can(agent, 'ticket.view.all')) {
    where.push(eq(conversations.assigneeAgentId, agent.id));
  }

  // Restricted channels are excluded in the query, for two different reasons
  // that happen to use the same clause.
  //
  // Permission is the first: an agent without `ticket.view.bot` must not reach
  // one however they ask, which is why forcing `?channel=whatsapp_bot` returns
  // nothing rather than working.
  //
  // The second is that the inbox is a working queue. These channels are opt-in:
  // absent from "all channels" even for an admin who may see them, and reached
  // by naming them in the filter. Without that, one number the team does not
  // answer buried the tickets that were actually waiting under nineteen hundred
  // transcripts. Search follows the same rule, so finding a bot conversation
  // means filtering to the channel first.
  const excluded = filters.channel === 'all' ? restrictedChannels() : hiddenChannels(agent);
  if (excluded.length) where.push(notInArray(conversations.channel, excluded));

  if (filters.view === 'mine') where.push(eq(conversations.assigneeAgentId, agent.id));
  if (filters.view === 'unassigned') where.push(isNull(conversations.assigneeAgentId));

  if (filters.statusCategory === 'unresolved') {
    where.push(inArray(ticketStatuses.category, ['open', 'pending']));
  } else if (filters.statusCategory !== 'all') {
    where.push(eq(ticketStatuses.category, filters.statusCategory));
  }

  if (filters.channel !== 'all') {
    where.push(eq(conversations.channel, filters.channel));
  }

  if (filters.q) {
    const { pattern, number, phonePattern, trackingNumber, sbid, scope } = parseSearchTerm(
      filters.q,
    );

    // A prefixed query is narrowed to its one clause. That is what makes typing
    // `track:` worth doing — the alternative ORs it into a list that still has
    // to consider every message body in the account.
    if (scope === 'tracking' && trackingNumber) {
      where.push(trackingMatches(trackingNumber));
    } else if (scope === 'sbid' && sbid) {
      where.push(sbidMatches(sbid));
    } else {
      const clauses: SQL[] = [
        ilike(conversations.subject, pattern),
        ilike(contacts.name, pattern),
        ilike(contacts.primaryEmail, pattern),
        ilike(contacts.primaryPhone, pattern),
        // What was actually said. Subjects on the messaging channels are picked
        // from a short list of canned categories, so hundreds of tickets share
        // one — searching them finds a category, never a conversation. The
        // tracking number or the sentence the agent half-remembers is in the
        // messages, which is where a search of a chat has to look.
        sql`EXISTS (
          SELECT 1 FROM ${messages} m
          WHERE m.conversation_id = ${conversations.id} AND m.body_text ILIKE ${pattern}
        )`,
        // And what the hub said. Often the only place the actual explanation
        // lives — "driver attempted twice, phone off" is written by somebody who
        // never appears on the ticket timeline, and it is what an agent
        // half-remembers weeks later. Only agents ever read this table, so
        // searching it raises no visibility question.
        sql`EXISTS (
          SELECT 1 FROM side_conversations sc
          JOIN side_conversation_messages sm ON sm.side_conversation_id = sc.id
          WHERE sc.conversation_id = ${conversations.id} AND sm.body_text ILIKE ${pattern}
        )`,
      ];

      if (number !== null) clauses.push(eq(conversations.number, number));
      if (phonePattern) clauses.push(ilike(contacts.primaryPhone, phonePattern));

      // The body search above already finds tickets that *mention* a number.
      // These two add every ticket that is *about* the shipment: the reply that
      // never quoted it, the one an agent linked by hand, the one where it
      // appeared only in a private note.
      if (trackingNumber) clauses.push(trackingMatches(trackingNumber));
      if (sbid) clauses.push(sbidMatches(sbid));

      where.push(or(...clauses)!);
    }
  }

  // "Older than the row the last page ended on", as a tuple so the id breaks
  // ties on identical timestamps. Matches the ORDER BY below exactly; if one
  // changes the other has to.
  if (cursor) {
    where.push(
      sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${cursor.time}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      subject: conversations.subject,
      channel: conversations.channel,
      priority: conversations.priority,
      statusName: ticketStatuses.name,
      statusCategory: ticketStatuses.category,
      requesterName: contacts.name,
      requesterEmail: contacts.primaryEmail,
      requesterPhone: contacts.primaryPhone,
      assigneeName: agents.name,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      // The cursor's timestamp, at the precision Postgres stores it. See
      // `InboxCursor` for why the mapped `Date` above cannot serve.
      cursorTime: sql<string>`${conversations.lastMessageAt}::text`,
      tags: conversations.tags,
      // The newest message body, for the two-line preview in the list. A
      // lateral subquery keeps this one round trip instead of N+1.
      preview: sql<string | null>`(
        SELECT m.body_text FROM ${messages} m
        WHERE m.conversation_id = ${conversations.id} AND m.kind <> 'note'
        ORDER BY m.created_at DESC LIMIT 1
      )`,
      // The newest message on the newest still-open side conversation. One
      // correlated subquery beside the preview one above rather than a join,
      // because a ticket with three threads must still produce one row.
      sideState: sql<string | null>`(
        SELECT CASE WHEN sm.direction = 'inbound' THEN 'replied' ELSE 'waiting' END
        FROM side_conversations sc
        JOIN side_conversation_messages sm ON sm.side_conversation_id = sc.id
        WHERE sc.conversation_id = ${conversations.id} AND sc.state = 'open'
        ORDER BY sm.created_at DESC LIMIT 1
      )`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .where(and(...where))
    // The id is part of the sort, not decoration: without a total order, two
    // rows sharing a timestamp could come back in either order and the cursor
    // would step over one of them.
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    // One extra row is the cheapest way to know whether a next page exists.
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];

  return {
    // A cursor only when there is more to fetch, so "no cursor" is the single
    // signal for "end of list" and the client needs no second flag.
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? encodeInboxCursor({ time: last.cursorTime, id: last.id })
        : null,
    rows: page.map((row) => ({
      id: row.id,
      number: row.number,
      subject: row.subject,
      channel: row.channel,
      priority: row.priority,
      statusName: row.statusName,
      statusCategory: row.statusCategory,
      requesterName: row.requesterName,
      requesterHandle: row.requesterEmail ?? row.requesterPhone,
      assigneeName: row.assigneeName,
      lastMessageAt: row.lastMessageAt,
      lastCustomerMessageAt: row.lastCustomerMessageAt,
      tags: row.tags,
      preview: row.preview,
      sideState: row.sideState === 'replied' || row.sideState === 'waiting' ? row.sideState : null,
    })),
  };
}

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

  const [timeline, files, events, shipments, accounts, sides] = await Promise.all([
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
      .orderBy(asc(messages.createdAt)),

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

// --- Lookups the console's controls are built from -------------------------

export async function listStatuses() {
  return db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      category: ticketStatuses.category,
    })
    .from(ticketStatuses)
    .orderBy(asc(ticketStatuses.position));
}

/**
 * The custom fields a ticket can carry, in the order an admin arranged them.
 *
 * Active fields only. Deactivating a field takes it off every form without
 * touching the values already stored, which is the point of the flag: a field
 * retired mid-quarter must not erase the answers the last three months of
 * tickets gave it, and a rule still reading `custom.<key>` keeps working on them.
 */
export async function listTicketFields(): Promise<TicketFieldDef[]> {
  return db
    .select({
      key: ticketFields.key,
      label: ticketFields.label,
      labelAr: ticketFields.labelAr,
      labelEn: ticketFields.labelEn,
      type: ticketFields.type,
      options: ticketFields.options,
      validation: ticketFields.validation,
      requiredOnCreate: ticketFields.requiredOnCreate,
      requiredOnResolve: ticketFields.requiredOnResolve,
      visibleToCustomer: ticketFields.visibleToCustomer,
      editableByCustomer: ticketFields.editableByCustomer,
    })
    .from(ticketFields)
    .where(eq(ticketFields.isActive, true))
    .orderBy(asc(ticketFields.position), asc(ticketFields.label));
}

/**
 * The one field a write is allowed to touch, re-read from the database.
 *
 * The key arrives in a FormData field, so the definition behind it is never
 * taken from the request: the type decides how the value is parsed and the
 * options decide what is accepted, and a caller who could supply those could
 * store anything under any key.
 */
export async function getTicketField(key: string): Promise<TicketFieldDef | null> {
  const rows = await listTicketFields();
  return rows.find((field) => field.key === key) ?? null;
}

/**
 * The canned responses this agent may insert.
 *
 * Three visibilities, and the scoping is the whole point of doing it in the
 * query rather than filtering a full list afterwards: `personal` belongs to one
 * agent and `group` to one team, so a list built without the `where` and
 * narrowed in the renderer is a list that was already sent to the browser. A
 * personal response is somebody's own draft wording — often with a name or an
 * account number still in it — and a group's belongs to a team this agent may
 * not be on.
 *
 * `agent_id` and `group_id` are only meaningful for their own visibility, so
 * each arm tests both: a `global` row with a stale `agent_id` left on it from an
 * earlier edit is still global, and a `personal` row whose `agent_id` is null is
 * visible to nobody rather than to everybody.
 */
export async function listCannedResponses(agent: SessionAgent) {
  return db
    .select({
      id: cannedResponses.id,
      title: cannedResponses.title,
      folder: cannedResponses.folder,
      bodyText: cannedResponses.bodyText,
    })
    .from(cannedResponses)
    .where(
      or(
        eq(cannedResponses.visibility, 'global'),
        and(eq(cannedResponses.visibility, 'personal'), eq(cannedResponses.agentId, agent.id)),
        and(
          eq(cannedResponses.visibility, 'group'),
          inArray(
            cannedResponses.groupId,
            db
              .select({ id: groupMembers.groupId })
              .from(groupMembers)
              .where(eq(groupMembers.agentId, agent.id)),
          ),
        ),
      ),
    )
    .orderBy(asc(cannedResponses.folder), asc(cannedResponses.title));
}

export type CannedResponseOption = Awaited<ReturnType<typeof listCannedResponses>>[number];

export async function listActiveAgents() {
  return db
    .select({ id: agents.id, name: agents.name, email: agents.email })
    .from(agents)
    .where(eq(agents.isActive, true))
    .orderBy(asc(agents.name));
}

export async function listGroups() {
  return db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name));
}

/**
 * Approved templates on one business account — anything else is rejected at
 * send time by Meta.
 *
 * Scoped to the account rather than listing the table, because a template is
 * approved on a WABA and not on the installation. Two connected accounts can
 * both have `shipment_update`, approved on one and rejected on the other, and
 * an unscoped picker would offer the agent whichever row happened to be there.
 * The send then fails asynchronously, on a status webhook, after the agent has
 * already been told it went.
 *
 * `null` means the rows that predate business accounts, which is the whole
 * table until the first sync adopts them.
 */
export async function listApprovedTemplates(whatsappAccountId: string | null) {
  return db
    .select({
      id: whatsappTemplates.id,
      name: whatsappTemplates.name,
      language: whatsappTemplates.language,
      category: whatsappTemplates.category,
      components: whatsappTemplates.components,
    })
    .from(whatsappTemplates)
    .where(
      and(
        eq(whatsappTemplates.status, 'APPROVED'),
        whatsappAccountId
          ? eq(whatsappTemplates.whatsappAccountId, whatsappAccountId)
          : isNull(whatsappTemplates.whatsappAccountId),
      ),
    )
    .orderBy(asc(whatsappTemplates.name));
}

export async function inboxCounts(agent: SessionAgent) {
  const base = [isNull(conversations.deletedAt), isNull(conversations.mergedIntoId)];
  if (!can(agent, 'ticket.view.all')) {
    base.push(eq(conversations.assigneeAgentId, agent.id));
  }

  // The nav badge counts what is waiting on the team, so a restricted channel is
  // out of it for everyone — an admin's inbox count is not a traffic meter for a
  // number nobody answers.
  base.push(notInArray(conversations.channel, restrictedChannels()));

  const rows = await db
    .select({
      mine: sql<number>`count(*) FILTER (WHERE ${conversations.assigneeAgentId} = ${agent.id})::int`,
      unassigned: sql<number>`count(*) FILTER (WHERE ${conversations.assigneeAgentId} IS NULL)::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(and(...base, inArray(ticketStatuses.category, ['open', 'pending'])));

  return rows[0] ?? { mine: 0, unassigned: 0, all: 0 };
}
