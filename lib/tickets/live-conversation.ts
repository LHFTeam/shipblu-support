import { and, desc, eq, isNull, ne, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, ticketStatuses } from '@/db/schema';
import type { StatusCategory } from './vocabulary';

/** The channels that thread on the person, not on a message or an external id. */
type PersonThreadedChannel = 'whatsapp' | 'whatsapp_bot' | 'webchat';

export type LiveConversation = {
  id: string;
  number: number;
  statusCategory: StatusCategory;
  reopenCount: number;
};

/**
 * Which of a contact's conversations on a channel can be their live one.
 *
 * Its own export so a test can read the statement back through `toSQL()`: the
 * WhatsApp path and the widget each wrote these conditions out, and the point
 * of sharing them is that they cannot drift apart again. Meta's direct
 * messages are not here, on purpose — they must also skip comment threads, which
 * live on the same channel and are told apart by `external_id`.
 *
 * Never an imported conversation: a WhatsApp Business app chat copied in after
 * a coexistence onboarding is filed resolved, and its newest message can be
 * yesterday's — the newest of the customer's conversations, and so the one a
 * reply would reopen. Its `created_at` is months old, so reopening it would
 * start the team's first-response clock against a ticket from April. A live
 * message opens its own; the import stays on the contact's record beside it.
 */
export function liveConversationFilter(contactId: string, channel: PersonThreadedChannel): SQL {
  return and(
    eq(conversations.requesterContactId, contactId),
    eq(conversations.channel, channel),
    isNull(conversations.deletedAt),
    isNull(conversations.mergedIntoId),
    ne(conversations.sourceSystem, 'import'),
  )!;
}

/**
 * The contact's current conversation on a channel that threads on the person,
 * if any.
 *
 * A closed conversation is deliberately *not* continued: closing is the team's
 * signal that the matter is finished, and reopening it weeks later would bury
 * the new question under old history. Resolved is different — that is a
 * pending-confirmation state, so a reply reopens it.
 */
export async function findLiveConversation(
  contactId: string,
  channel: PersonThreadedChannel,
): Promise<LiveConversation | null> {
  const row = await findLatestConversation(contactId, channel);
  if (!row || row.statusCategory === 'closed') return null;
  return row;
}

/**
 * The contact's newest conversation on the channel, closed or not: the one
 * `findLiveConversation` reads before deciding whether it may be continued.
 *
 * For something that belongs on the customer's thread without continuing it —
 * a WhatsApp reaction, which changes nothing about the ticket it is filed on, so
 * a closed one is as good a home as any (`ingestWhatsAppReaction`).
 */
export async function findLatestConversation(
  contactId: string,
  channel: PersonThreadedChannel,
): Promise<LiveConversation | null> {
  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      statusCategory: ticketStatuses.category,
      reopenCount: conversations.reopenCount,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(liveConversationFilter(contactId, channel))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  return rows[0] ?? null;
}
