import { and, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, ticketStatuses } from '@/db/schema';
import type { StatusCategory } from './vocabulary';

/**
 * What a conversation on a chat channel is threaded on: the person, and — on
 * WhatsApp — which of our numbers they wrote to.
 *
 * The number is part of the key because a number can be one team member's: a
 * merchant writing to one member's number and then to another's is two
 * conversations, each answered from its own phone and each measured against
 * its own person. Keyed on the person alone, the second message continued the
 * first number's ticket, an echo typed on the second phone stopped the first
 * ticket's clocks, and a reaction on one number was filed on the other's.
 *
 * `channelId` is the `channels` row of the number, or null for one no row
 * names — and null matches only null (`channel_id is null`), never "any
 * number": a wildcard would let a ticket with no row absorb that person's
 * messages to every number, which is the bug the key exists to close.
 *
 * The widget and the bot keep the person alone. The widget has one channel, and
 * its older tickets carry no `channel_id`; the bot has one number, whose
 * transcripts all carry its row already.
 */
export type ThreadKey =
  | { channel: 'webchat' }
  | { channel: 'whatsapp_bot' }
  | { channel: 'whatsapp'; channelId: string | null };

export type LiveConversation = {
  id: string;
  number: number;
  statusCategory: StatusCategory;
  reopenCount: number;
};

/**
 * The one statement of "the same thread", shared by both finders so the live
 * conversation and the newest one cannot be asked of different keys.
 *
 * The number's condition sits between the channel and the rest, and is absent
 * for every other key, so the widget's and the bot's statements are exactly
 * what they were before WhatsApp threaded on the number (pinned by
 * `live-conversation.test.ts`).
 */
function threadConditions(contactId: string, key: ThreadKey): SQL[] {
  return [
    eq(conversations.requesterContactId, contactId),
    eq(conversations.channel, key.channel),
    ...(key.channel === 'whatsapp'
      ? [
          key.channelId === null
            ? isNull(conversations.channelId)
            : eq(conversations.channelId, key.channelId),
        ]
      : []),
    isNull(conversations.deletedAt),
    isNull(conversations.mergedIntoId),
  ];
}

/**
 * Which of a contact's conversations on a thread can be their live one.
 *
 * Its own export so a test can read the statement back through `toSQL()`: the
 * WhatsApp path and the widget each wrote these conditions out, and the point
 * of sharing them is that they cannot drift apart again. Meta's direct
 * messages are not here, on purpose — they must also skip comment threads, which
 * may still live on the same channel (until `split_comment_channels` has moved
 * them to `facebook_comment` / `instagram_comment`) and are told apart by
 * `external_id`.
 *
 * Never an imported conversation: a WhatsApp Business app chat copied in after
 * a coexistence onboarding is filed resolved, and its newest message can be
 * yesterday's — the newest of the customer's conversations, and so the one a
 * reply would reopen. Its `created_at` is months old, so reopening it would
 * start the team's first-response clock against a ticket from April. A live
 * message opens its own; the import stays on the contact's record beside it.
 */
export function liveConversationFilter(contactId: string, key: ThreadKey): SQL {
  return and(...threadConditions(contactId, key), ne(conversations.sourceSystem, 'import'))!;
}

/**
 * The contact's current conversation on a thread, if any.
 *
 * A closed conversation is deliberately *not* continued: closing is the team's
 * signal that the matter is finished, and reopening it weeks later would bury
 * the new question under old history. Resolved is different — that is a
 * pending-confirmation state, so a reply reopens it.
 *
 * Takes the transaction when the caller is about to create the conversation it
 * did not find: asked outside it, two deliveries for one thread each find
 * nothing and each insert a ticket (`lockThread`).
 */
export async function findLiveConversation(
  contactId: string,
  key: ThreadKey,
  executor: typeof db = db,
): Promise<LiveConversation | null> {
  const rows = await executor
    .select({
      id: conversations.id,
      number: conversations.number,
      statusCategory: ticketStatuses.category,
      reopenCount: conversations.reopenCount,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(liveConversationFilter(contactId, key))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  const row = rows[0];
  if (!row || row.statusCategory === 'closed') return null;
  return row;
}

/**
 * The contact's newest conversation on a thread, whatever its status, and the
 * copied histories included — so a caller can tell when the newest thing the
 * person has with us is a record rather than a ticket.
 *
 * For a WhatsApp reaction, which belongs on the customer's thread without
 * continuing it (`ingestWhatsAppReaction`). The import is the half that matters:
 * left out, a coexistence customer reacting to a message from their copied
 * phone history would have the reaction filed on whatever native ticket came
 * before it — closed, and possibly months old.
 */
export async function findNewestConversation(
  contactId: string,
  key: ThreadKey,
  executor: typeof db = db,
): Promise<{ id: string; number: number; imported: boolean } | null> {
  const [row] = await executor
    .select({
      id: conversations.id,
      number: conversations.number,
      sourceSystem: conversations.sourceSystem,
    })
    .from(conversations)
    .where(and(...threadConditions(contactId, key)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  return row ? { id: row.id, number: row.number, imported: row.sourceSystem === 'import' } : null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialises everything that may create a conversation on one thread, until
 * the caller's transaction ends.
 *
 * Finding the live conversation and inserting one when there is none is a
 * read-then-write: two deliveries for the same thread — two messages in a
 * row, or a customer's message and the phone's reply to it, processed by two
 * workers at once — each found nothing and each opened a ticket. Production has pairs created 35–120 ms
 * apart, and the half the reply did not land on keeps a first-response clock
 * nobody can stop. Taken first, then the find inside the same transaction, the
 * second delivery waits for the first to commit and then finds its ticket.
 *
 * An advisory lock rather than a row lock, because the row that would be locked
 * is the one that does not exist yet; and the `_xact_` form, released by the
 * commit, because the transaction pooler hands the connection to somebody else
 * at that moment and a session lock would go with it. Keyed on exactly the
 * thread, so two customers, or one customer on two numbers, never wait on each
 * other. Typed for a transaction, because outside one the lock would be
 * released as soon as it was taken.
 */
export async function lockThread(tx: Tx, contactId: string, key: ThreadKey): Promise<void> {
  const number = key.channel === 'whatsapp' ? (key.channelId ?? 'none') : 'none';
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${contactId}:${key.channel}:${number}`}::text, 0))`,
  );
}
