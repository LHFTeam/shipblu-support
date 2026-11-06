import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { db } from '@/db/client';
import { CATEGORY_AI_LIVE_LABEL, aiCategoryRuns, conversationEvents, messages } from '@/db/schema';
import { CATEGORY_AI_ACTOR } from '@/lib/category-ai/decide';
import { canonicalUuid } from '@/lib/http/uuid';
import { isCommentTicket } from '@/lib/tickets/channel-policy';
import type { CategorySource } from './decide';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Whose words the category a ticket carries stands on (`categoryStanding`,
 * `lib/routing/decide.ts`, says what the router does with the answer). Read in
 * the router's phase one, inside the transaction that holds the ticket's row,
 * so the requester it compares against is the one adoption left
 * (`adoptRootAuthor`, whose compare-and-set takes the same row), and a root
 * comment stored by an adoption that committed is visible with it.
 *
 * Jev's own record says which message each of its answers was about: the
 * `category_changed` event a write leaves names the message, and the live run
 * an `applied` answer leaves names it too — the second because an answer
 * agreeing with the category the ticket already carries writes no event
 * (`setConversationCategoryOn` writes nothing on an unchanged value), so the
 * customer's root answering what the replier's reply was read as would
 * otherwise read as the replier's category still.
 *
 * An answer about a message deleted since, or one an event names no message
 * for, counts as the requester's: nothing says it was anybody else's, which is
 * how the classifiers count such a run as well.
 */
export async function categorySource(
  tx: Tx,
  ticket: {
    id: string;
    categoryId: string | null;
    categoryKey: string | null;
    requesterContactId: string | null;
    channel: string;
    externalId: string | null;
  },
  openerMessageId: string | null,
): Promise<CategorySource | null> {
  if (!ticket.categoryId) return null;

  const [last] = await tx
    .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, ticket.id),
        eq(conversationEvents.type, 'category_changed'),
      ),
    )
    .orderBy(desc(conversationEvents.createdAt), desc(conversationEvents.id))
    .limit(1);
  // Only when the column still holds what Jev's write left: one moved without
  // an event is somebody else's, as `categoryOwned` reads it.
  const readByJev = last?.actorLabel === CATEGORY_AI_ACTOR && last.data.to === ticket.categoryId;
  if (!readByJev) return { readByJev: false, notTheRequesters: false, awaitingRoot: false };

  return {
    readByJev,
    notTheRequesters: !(await requesterChose(tx, ticket)),
    awaitingRoot: await awaitingRoot(tx, ticket, openerMessageId),
  };
}

/**
 * Whether some answer of Jev's that chose the ticket's category was about a
 * message that is not somebody else's than the requester's.
 */
async function requesterChose(
  tx: Tx,
  ticket: {
    id: string;
    categoryId: string | null;
    categoryKey: string | null;
    requesterContactId: string | null;
  },
): Promise<boolean> {
  if (!ticket.requesterContactId) return true;

  const writes = await tx
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, ticket.id),
        eq(conversationEvents.type, 'category_changed'),
        eq(conversationEvents.actorLabel, CATEGORY_AI_ACTOR),
      ),
    );
  const answered: (string | null)[] = writes
    .filter((write) => write.data.to === ticket.categoryId)
    // Spelled as the database spells an id, as `ticketFacts` reads the same
    // field: a job run by hand with an upper-case id writes it so, and would
    // otherwise name no message the lookup below finds. An id that is not one
    // names no message, and so counts as the requester's, rather than refusing
    // the whole decision with 22P02.
    .map((write) => canonicalUuid(write.data.messageId));

  if (ticket.categoryKey) {
    const runs = await tx
      .select({ messageId: aiCategoryRuns.messageId })
      .from(aiCategoryRuns)
      .where(
        and(
          eq(aiCategoryRuns.conversationId, ticket.id),
          eq(aiCategoryRuns.runLabel, CATEGORY_AI_LIVE_LABEL),
          eq(aiCategoryRuns.outcome, 'applied'),
          eq(aiCategoryRuns.predictedKey, ticket.categoryKey),
        ),
      );
    answered.push(...runs.map((run) => run.messageId));
  }

  if (answered.includes(null)) return true;
  const named = [...new Set(answered.filter((id): id is string => id !== null))];
  if (named.length === 0) return false;

  const authors = await tx
    .select({ id: messages.id, authorContactId: messages.authorContactId })
    .from(messages)
    .where(inArray(messages.id, named));
  const byId = new Map(authors.map((row) => [row.id, row.authorContactId]));
  return named.some((id) => {
    const author = byId.get(id);
    return !author || author === ticket.requesterContactId;
  });
}

/**
 * A comment thread a reply opened — the routing row's message is a reply
 * comment — whose root comment has not been stored on it since. Every comment
 * on a comment ticket is filed with the comment it answers (`in_reply_to`), and
 * a root answers none.
 */
async function awaitingRoot(
  tx: Tx,
  ticket: { id: string; channel: string; externalId: string | null },
  openerMessageId: string | null,
): Promise<boolean> {
  if (!openerMessageId || !isCommentTicket(ticket.channel, ticket.externalId)) return false;

  const [opener] = await tx
    .select({ inReplyTo: messages.inReplyTo })
    .from(messages)
    .where(eq(messages.id, openerMessageId));
  if (!opener?.inReplyTo) return false;

  const [root] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, ticket.id),
        eq(messages.direction, 'inbound'),
        eq(messages.kind, 'reply'),
        isNull(messages.inReplyTo),
      ),
    )
    .limit(1);
  return !root;
}
