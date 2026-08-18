import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  conversationEvents,
  conversations,
  contacts,
  groups,
  messages,
  ticketStatuses,
  whatsappTemplates,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';

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
  channel: 'all' | 'email' | 'whatsapp' | 'webchat';
  q: string;
  page: number;
};

export const PAGE_SIZE = 30;

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
    channel:
      channel === 'email' || channel === 'whatsapp' || channel === 'webchat' ? channel : 'all',
    q: (one('q') ?? '').trim(),
    page: Math.max(1, Number(one('page') ?? '1') || 1),
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
};

export async function listInbox(
  agent: SessionAgent,
  filters: InboxFilters,
): Promise<{ rows: InboxRow[]; hasMore: boolean }> {
  const where = [isNull(conversations.deletedAt), isNull(conversations.mergedIntoId)];

  // Visibility is enforced in the query, not the template: an agent who can
  // only see their own tickets must not be able to reach another's by URL, and
  // filtering after the fact would still have loaded the row.
  if (!can(agent, 'ticket.view.all')) {
    where.push(eq(conversations.assigneeAgentId, agent.id));
  }

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
    const term = `%${filters.q}%`;
    const asNumber = Number(filters.q.replace(/^#/, ''));

    const clauses: SQL[] = [
      ilike(conversations.subject, term),
      ilike(contacts.name, term),
      ilike(contacts.primaryEmail, term),
      ilike(contacts.primaryPhone, term),
    ];
    // "#1234" is how the team refers to a ticket, so make it a direct hit
    // rather than a substring search that happens to match the subject.
    if (Number.isInteger(asNumber) && asNumber > 0) {
      clauses.push(eq(conversations.number, asNumber));
    }
    where.push(or(...clauses)!);
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
      tags: conversations.tags,
      // The newest message body, for the two-line preview in the list. A
      // lateral subquery keeps this one round trip instead of N+1.
      preview: sql<string | null>`(
        SELECT m.body_text FROM ${messages} m
        WHERE m.conversation_id = ${conversations.id} AND m.kind <> 'note'
        ORDER BY m.created_at DESC LIMIT 1
      )`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .where(and(...where))
    .orderBy(desc(conversations.lastMessageAt))
    // One extra row is the cheapest way to know whether a next page exists.
    .limit(PAGE_SIZE + 1)
    .offset((filters.page - 1) * PAGE_SIZE);

  const hasMore = rows.length > PAGE_SIZE;

  return {
    rows: rows.slice(0, PAGE_SIZE).map((row) => ({
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
    })),
    hasMore,
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
  assigneeAgentId: string | null;
  assigneeName: string | null;
  groupId: string | null;
  groupName: string | null;
  requester: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  lastCustomerMessageAt: Date | null;
  createdAt: Date;
  reopenCount: number;
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

  const rows = await db
    .select({
      conversation: conversations,
      statusName: ticketStatuses.name,
      statusCategory: ticketStatuses.category,
      requesterId: contacts.id,
      requesterName: contacts.name,
      requesterEmail: contacts.primaryEmail,
      requesterPhone: contacts.primaryPhone,
      assigneeName: agents.name,
      groupName: groups.name,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .leftJoin(groups, eq(groups.id, conversations.groupId))
    .where(and(...where))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [timeline, files, events] = await Promise.all([
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
  ]);

  const filesByMessage = new Map<string, ConversationDetail['messages'][number]['attachments']>();
  for (const file of files) {
    const list = filesByMessage.get(file.messageId) ?? [];
    list.push({
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    });
    filesByMessage.set(file.messageId, list);
  }

  return {
    id: row.conversation.id,
    number: row.conversation.number,
    subject: row.conversation.subject,
    channel: row.conversation.channel,
    priority: row.conversation.priority,
    type: row.conversation.type,
    statusId: row.conversation.statusId,
    statusName: row.statusName,
    statusCategory: row.statusCategory,
    tags: row.conversation.tags,
    assigneeAgentId: row.conversation.assigneeAgentId,
    assigneeName: row.assigneeName,
    groupId: row.conversation.groupId,
    groupName: row.groupName,
    requester: {
      id: row.requesterId,
      name: row.requesterName,
      email: row.requesterEmail,
      phone: row.requesterPhone,
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

/** Approved templates only — anything else is rejected at send time by Meta. */
export async function listApprovedTemplates() {
  return db
    .select({
      id: whatsappTemplates.id,
      name: whatsappTemplates.name,
      language: whatsappTemplates.language,
      category: whatsappTemplates.category,
      components: whatsappTemplates.components,
    })
    .from(whatsappTemplates)
    .where(eq(whatsappTemplates.status, 'APPROVED'))
    .orderBy(asc(whatsappTemplates.name));
}

export async function inboxCounts(agent: SessionAgent) {
  const base = [isNull(conversations.deletedAt), isNull(conversations.mergedIntoId)];
  if (!can(agent, 'ticket.view.all')) {
    base.push(eq(conversations.assigneeAgentId, agent.id));
  }

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
