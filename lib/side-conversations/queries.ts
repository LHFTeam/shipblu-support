import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  internalRecipients,
  sideConversationMessages,
  sideConversations,
} from '@/db/schema';

/**
 * Read models for side conversations.
 *
 * Nothing here takes a `SessionAgent`. A side conversation has no visibility
 * rule of its own — it is as visible as the ticket it hangs off, no more and no
 * less — so the caller loads the ticket through `getConversation`, which applies
 * the agent's rule, and then asks for these. Giving this module its own copy of
 * that rule would be a second place for it to drift, and the answer would be the
 * same every time.
 */

export type SideConversationMessageView = {
  id: string;
  direction: 'inbound' | 'outbound';
  /** The agent who asked, or the person at the hub who answered. */
  authorName: string | null;
  authorAddress: string | null;
  bodyHtml: string | null;
  bodyText: string;
  deliveryStatus: string;
  deliveryError: string | null;
  /**
   * An out-of-office is not the hub's answer. Recorded at ingest and surfaced so
   * the card can dim it rather than counting it as a reply.
   */
  isAutomated: boolean;
  createdAt: Date;
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[];
};

export type SideConversationView = {
  id: string;
  number: number;
  subject: string;
  channel: string;
  state: 'open' | 'done';
  /** The directory entry's name, or null when the agent typed an address. */
  recipientName: string | null;
  recipientKind: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  createdByName: string | null;
  anchorMessageId: string | null;
  createdAt: Date;
  lastMessageAt: Date;
  lastInboundAt: Date | null;
  /** Open, and the last word was ours. What the "awaiting reply" badge reads. */
  awaitingReply: boolean;
  messages: SideConversationMessageView[];
};

/**
 * Every side conversation on a ticket, with its messages.
 *
 * Three queries rather than a join with repeated headers, matching how
 * `getConversation` already loads its timeline and attachments: threads are few
 * and messages are few, and grouping in memory keeps the row shapes honest.
 */
export async function sideConversationsForConversation(
  conversationId: string,
): Promise<SideConversationView[]> {
  const headers = await db
    .select({
      side: sideConversations,
      recipientName: internalRecipients.name,
      recipientKind: internalRecipients.kind,
      createdByName: agents.name,
    })
    .from(sideConversations)
    .leftJoin(internalRecipients, eq(internalRecipients.id, sideConversations.recipientId))
    .leftJoin(agents, eq(agents.id, sideConversations.createdByAgentId))
    .where(eq(sideConversations.conversationId, conversationId))
    .orderBy(asc(sideConversations.createdAt));

  if (headers.length === 0) return [];

  const ids = headers.map((row) => row.side.id);

  const [rows, files] = await Promise.all([
    db
      .select({ message: sideConversationMessages, agentName: agents.name })
      .from(sideConversationMessages)
      .leftJoin(agents, eq(agents.id, sideConversationMessages.authorAgentId))
      .where(inArray(sideConversationMessages.sideConversationId, ids))
      .orderBy(asc(sideConversationMessages.createdAt)),

    db
      .select({
        id: attachments.id,
        sideMessageId: attachments.sideMessageId,
        filename: attachments.filename,
        contentType: attachments.contentType,
        sizeBytes: attachments.sizeBytes,
      })
      .from(attachments)
      .innerJoin(
        sideConversationMessages,
        eq(sideConversationMessages.id, attachments.sideMessageId),
      )
      .where(inArray(sideConversationMessages.sideConversationId, ids)),
  ]);

  const filesByMessage = new Map<string, SideConversationMessageView['attachments']>();
  for (const file of files) {
    if (!file.sideMessageId) continue;
    const list = filesByMessage.get(file.sideMessageId) ?? [];
    list.push({
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    });
    filesByMessage.set(file.sideMessageId, list);
  }

  const messagesByThread = new Map<string, SideConversationMessageView[]>();
  for (const row of rows) {
    const list = messagesByThread.get(row.message.sideConversationId) ?? [];
    list.push({
      id: row.message.id,
      direction: row.message.direction,
      // An inbound message has no agent; the display name off the envelope is
      // the whole point of storing it. Falling back to the address means a hub
      // that sends without a display name still says who answered.
      authorName:
        row.message.direction === 'outbound'
          ? row.agentName
          : (row.message.fromName ?? row.message.fromAddress),
      authorAddress: row.message.fromAddress,
      bodyHtml: row.message.bodyHtml,
      bodyText: row.message.bodyText,
      deliveryStatus: row.message.deliveryStatus,
      deliveryError: row.message.deliveryError,
      isAutomated: (row.message.meta as { isAutomated?: boolean }).isAutomated === true,
      createdAt: row.message.createdAt,
      attachments: filesByMessage.get(row.message.id) ?? [],
    });
    messagesByThread.set(row.message.sideConversationId, list);
  }

  return headers.map((row) => {
    const messages = messagesByThread.get(row.side.id) ?? [];
    const last = messages[messages.length - 1];

    return {
      id: row.side.id,
      number: row.side.number,
      subject: row.side.subject,
      channel: row.side.channel,
      state: row.side.state,
      recipientName: row.recipientName,
      recipientKind: row.recipientKind,
      toAddresses: row.side.toAddresses,
      ccAddresses: row.side.ccAddresses,
      createdByName: row.createdByName,
      anchorMessageId: row.side.anchorMessageId,
      createdAt: row.side.createdAt,
      lastMessageAt: row.side.lastMessageAt,
      lastInboundAt: row.side.lastInboundAt,
      // Derived rather than stored: a column would be a third thing to keep in
      // step with the message list and the state, and it is one comparison.
      awaitingReply: row.side.state === 'open' && (last?.direction ?? 'outbound') === 'outbound',
      messages,
    };
  });
}

/**
 * Loads one thread with the ticket it belongs to, for the reply and close
 * actions.
 *
 * Returns the parent conversation id so the caller can re-run the ticket's own
 * visibility check against it. An action that trusted the side conversation id
 * alone would be a way to write into a ticket the agent cannot see, which is the
 * same bug `loadConversation` was written to avoid.
 */
export async function loadSideConversation(sideConversationId: string) {
  const rows = await db
    .select({
      side: sideConversations,
      recipientName: internalRecipients.name,
    })
    .from(sideConversations)
    .leftJoin(internalRecipients, eq(internalRecipients.id, sideConversations.recipientId))
    .where(eq(sideConversations.id, sideConversationId))
    .limit(1);

  return rows[0] ?? null;
}

/** The most recent message on a thread — the parent for the References chain. */
export async function lastSideMessageId(sideConversationId: string): Promise<string | null> {
  const rows = await db
    .select({ channelMessageId: sideConversationMessages.channelMessageId })
    .from(sideConversationMessages)
    .where(eq(sideConversationMessages.sideConversationId, sideConversationId))
    .orderBy(desc(sideConversationMessages.createdAt))
    .limit(1);

  return rows[0]?.channelMessageId ?? null;
}

// --- The directory ----------------------------------------------------------

export type InternalRecipient = {
  id: string;
  name: string;
  email: string;
  kind: 'hub' | 'team' | 'vendor';
  description: string | null;
  isActive: boolean;
};

export async function listInternalRecipients(
  options: { activeOnly?: boolean } = {},
): Promise<InternalRecipient[]> {
  const where = options.activeOnly ? [eq(internalRecipients.isActive, true)] : [];

  return db
    .select({
      id: internalRecipients.id,
      name: internalRecipients.name,
      email: internalRecipients.email,
      kind: internalRecipients.kind,
      description: internalRecipients.description,
      isActive: internalRecipients.isActive,
    })
    .from(internalRecipients)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(internalRecipients.kind), asc(internalRecipients.name));
}
