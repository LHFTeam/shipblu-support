import { and, desc, eq, isNull, ne, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, ticketStatuses } from '@/db/schema';
import type { MetaPlatform } from '@/lib/meta/types';
import { isMetaChannel } from './channel-policy';
import type { StatusCategory } from './vocabulary';

/** The channels that thread on the person, not on a message or an external id. */
type PersonThreadedChannel = 'whatsapp' | 'whatsapp_bot' | 'webchat' | MetaPlatform;

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
 * WhatsApp path, the widget and Meta's direct messages each wrote these
 * conditions out, and the point of sharing them is that they cannot drift apart
 * again. Meta's copy already had: it skipped neither a merged-away ticket nor an
 * import.
 *
 * Meta's direct messages ask one thing more, that the ticket has no external
 * id: on `facebook` / `instagram` that is a public comment thread, which a
 * private message must never continue. The comment channels and their CHECK
 * (`db/sql/008_comment_channel_check.sql`) keep comments off those channels
 * today, but the documented rollback of Stage 1.2 of
 * `plans/ticket-category-routing.md` puts them back there, and this condition
 * is what keeps the inbox's messages and its public threads apart while it
 * does. The other channels carry no comment threads, so their statement is
 * unchanged.
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
    isMetaChannel(channel) ? isNull(conversations.externalId) : undefined,
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

  const row = rows[0];
  if (!row || row.statusCategory === 'closed') return null;
  return row;
}

/**
 * The contact's newest conversation on the channel, whatever its status, and
 * the copied histories included — so a caller can tell when the newest thing
 * the person has with us is a record rather than a ticket.
 *
 * For a WhatsApp reaction, which belongs on the customer's thread without
 * continuing it (`ingestWhatsAppReaction`). The import is the half that matters:
 * left out, a coexistence customer reacting to a message from their copied
 * phone history would have the reaction filed on whatever native ticket came
 * before it — closed, and possibly months old.
 *
 * Not on Meta's channels: it asks nothing but the person and the channel, and
 * on `facebook` or `instagram` that can be a public comment thread
 * (`liveConversationFilter`).
 */
export async function findNewestConversation(
  contactId: string,
  channel: Exclude<PersonThreadedChannel, MetaPlatform>,
): Promise<{ id: string; number: number; imported: boolean } | null> {
  const [row] = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      sourceSystem: conversations.sourceSystem,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.requesterContactId, contactId),
        eq(conversations.channel, channel),
        isNull(conversations.deletedAt),
        isNull(conversations.mergedIntoId),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  return row ? { id: row.id, number: row.number, imported: row.sourceSystem === 'import' } : null;
}
