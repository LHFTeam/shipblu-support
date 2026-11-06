import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  CATEGORY_AI_LIVE_LABEL,
  aiCategoryRuns,
  conversationEvents,
  conversations,
  messages,
  routingDecisions,
  ticketCategories,
} from '@/db/schema';
import { CATEGORY_AI_ACTOR } from '@/lib/category-ai/decide';
import { canonicalUuid } from '@/lib/http/uuid';
import { isCommentTicket } from '@/lib/tickets/channel-policy';
import { writtenByAnother } from '@/lib/tickets/classifiable';
import { categoryStanding, type CategorySource } from './decide';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Whose words the category a ticket carries stands on (`categoryStanding`,
 * `lib/routing/decide.ts`, says what the router does with the answer). Read in
 * the router's phase one, inside the transaction that holds the ticket's row,
 * so the requester it compares against is the one adoption left
 * (`adoptRootAuthor`, whose compare-and-set takes the same row), and a root
 * comment stored by an adoption that committed is visible with it.
 *
 * Null — nothing to hold back — for any ticket that is not a comment thread,
 * which costs a decision there no read at all. Only adoption makes the
 * requester somebody other than the author of what Jev was asked about: a
 * contact merge moves the ticket's requester and the contact's messages in one
 * transaction (`mergeContacts`), and nothing else writes the requester of a
 * ticket that exists. So on Web Chat, email or a direct message the answer is
 * always "the requester's", and asking it read up to six statements under the
 * ticket's lock and the routing row's for nothing.
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
  executor: Executor,
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
  if (!ticket.categoryId || !isCommentTicket(ticket.channel, ticket.externalId)) return null;
  const last = await lastCategoryWrite(executor, ticket);
  return standingOf(executor, ticket, openerMessageId, last?.byJev === true);
}

/**
 * The category's last `category_changed`: whether it is Jev's and still what
 * the column holds, and when it was written — stamped under the ticket's lock
 * (`CHANGE_STAMP`), so it orders against anything else written there. Only
 * when the column still holds what Jev's write left: one moved without an
 * event is somebody else's, as `categoryOwned` reads it.
 */
async function lastCategoryWrite(
  executor: Executor,
  ticket: { id: string; categoryId: string | null },
): Promise<{ byJev: boolean; eventId: string; messageId: string | null } | null> {
  const [last] = await executor
    .select({
      id: conversationEvents.id,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, ticket.id),
        eq(conversationEvents.type, 'category_changed'),
      ),
    )
    .orderBy(desc(conversationEvents.createdAt), desc(conversationEvents.id))
    .limit(1);
  if (!last) return null;
  return {
    byJev: last.actorLabel === CATEGORY_AI_ACTOR && last.data.to === ticket.categoryId,
    eventId: last.id,
    // Spelled as the database spells an id, as `requesterChose` reads it.
    messageId: canonicalUuid(last.data.messageId),
  };
}

async function standingOf(
  executor: Executor,
  ticket: Parameters<typeof requesterChose>[1] & { id: string },
  openerMessageId: string | null,
  readByJev: boolean,
): Promise<CategorySource> {
  if (!readByJev) return { readByJev: false, notTheRequesters: false, awaitingRoot: false };

  // Once the words are somebody else's, whether the root is still to come
  // changes nothing `categoryStanding` answers, so it is not read.
  const notTheRequesters = !(await requesterChose(executor, ticket));
  return {
    readByJev,
    notTheRequesters,
    awaitingRoot: notTheRequesters ? false : await awaitingRoot(executor, ticket, openerMessageId),
  };
}

/**
 * Whether a person's or a rule's end of a hold left Jev's category owed what
 * the router would have given it: the SLA policy's look at it and, where the
 * ending ran no pass of its own, the `on_update` rules (`afterHoldEnded`).
 *
 * Jev's write on a held ticket hands both to the router (`routerDecidedOn`):
 * when `routeNow` answers `waiting` — the router waiting for a comment
 * thread's root (`categoryStanding`) — or `failed`, or the creation pass has
 * not yet routed (`pending`). A person can then end the hold first, through
 * `endHold`, which decides without the category, and the router's pass and
 * policy never come. Owed only where the window's end would have routed on it:
 * Jev's reading of the requester's own words, which on any ticket but a
 * comment thread is every reading of Jev's (`categorySource` answers nothing
 * there). A category read off a passer-by is set aside at the window's end —
 * no pass and no policy — and a person taking the ticket first must not give
 * it either. Not for anything the router decided itself, which ran both, nor a
 * category a person or a rule wrote, whose write ran its own.
 *
 * And only for a write the hold's end came after. Jev's write landing once the
 * hold is over finds the row decided under its lock and is an ordinary
 * relabel, which runs its pass and chooses the policy itself
 * (`afterCategoryApplied`); owed here too, an agent's reply ending the hold a
 * moment before would run the same rules a second time. Both stamps are taken
 * under the ticket's lock (`CHANGE_STAMP`, the `routed` line `endHold`
 * writes), which the two writes serialise on, so they order as the writes did.
 *
 * Read after the hold's end has committed and outside any lock, by
 * `heldFollowUp` alone: one read, so the pass and the policy cannot be given
 * different answers.
 */
export async function jevCategoryOwed(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({
      outcome: routingDecisions.outcome,
      messageId: routingDecisions.messageId,
      categoryId: conversations.categoryId,
      categoryKey: ticketCategories.key,
      requesterContactId: conversations.requesterContactId,
      channel: conversations.channel,
      externalId: conversations.externalId,
    })
    .from(routingDecisions)
    .innerJoin(conversations, eq(conversations.id, routingDecisions.conversationId))
    .leftJoin(ticketCategories, eq(ticketCategories.id, conversations.categoryId))
    .where(eq(routingDecisions.conversationId, conversationId));
  if (!row?.categoryId || (row.outcome !== 'manual' && row.outcome !== 'rule')) return false;

  const ticket = { id: conversationId, ...row };
  const last = await lastCategoryWrite(db, ticket);
  if (!last?.byJev) return false;

  // Compared in the database, to the microsecond `clock_timestamp()` keeps: read
  // back as a JavaScript Date, two stamps a fraction of a millisecond apart are
  // one instant, and a write just before the end would read as after it.
  const [ended] = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'routed'),
        sql`${conversationEvents.data}->>'outcome' = ${row.outcome}`,
        sql`${conversationEvents.createdAt} > (select written.created_at from conversation_events written where written.id = ${last.eventId})`,
      ),
    )
    .limit(1);
  if (!ended) return false;

  if (!isCommentTicket(row.channel, row.externalId)) return true;
  const source = await standingOf(db, ticket, row.messageId, true);
  return categoryStanding(source, true) === 'routes';
}

/**
 * Whether the category a comment ticket carries is Jev's reading of a message
 * somebody other than the requester wrote: a passer-by's reply that opened the
 * thread, read before the customer's comment took the ticket over
 * (`adoptRootAuthor`). Asked of a confident answer of the requester's naming
 * that same category, which writes nothing (`setConversationCategoryOn`, on an
 * unchanged value) and so would otherwise leave the ticket as the passer-by's
 * reading left it: set aside at the window's end with no policy, or past a
 * hold a person ended while the words were still his. The answer makes the
 * category hers, and is owed the policy's look a write would have had
 * (`afterCategoryConfirmed`).
 *
 * Off a comment thread every reading of Jev's is the requester's, so false.
 */
export async function categoryReadOffAnother(conversationId: string): Promise<boolean> {
  const [ticket] = await db
    .select({
      categoryId: conversations.categoryId,
      requesterContactId: conversations.requesterContactId,
      channel: conversations.channel,
      externalId: conversations.externalId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!ticket?.categoryId || !isCommentTicket(ticket.channel, ticket.externalId)) return false;

  const last = await lastCategoryWrite(db, { id: conversationId, categoryId: ticket.categoryId });
  if (!last?.byJev || !last.messageId) return false;
  const [read] = await db
    .select({ authorContactId: messages.authorContactId })
    .from(messages)
    .where(eq(messages.id, last.messageId));
  return writtenByAnother(read?.authorContactId, ticket.requesterContactId);
}

/**
 * Whether some answer of Jev's that chose the ticket's category was about a
 * message nobody other than the requester wrote (`writtenByAnother`).
 */
async function requesterChose(
  executor: Executor,
  ticket: {
    id: string;
    categoryId: string | null;
    categoryKey: string | null;
    requesterContactId: string | null;
  },
): Promise<boolean> {
  if (!ticket.requesterContactId) return true;

  const writes = await executor
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
    const runs = await executor
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

  const authors = await executor
    .select({ id: messages.id, authorContactId: messages.authorContactId })
    .from(messages)
    .where(inArray(messages.id, named));
  const byId = new Map(authors.map((row) => [row.id, row.authorContactId]));
  return named.some((id) => !writtenByAnother(byId.get(id), ticket.requesterContactId));
}

/**
 * A comment thread a reply opened — the routing row's message is a reply
 * comment — whose root comment has not been stored on it since. Every comment
 * on a comment ticket is filed with the comment it answers (`in_reply_to`), and
 * a root answers none.
 */
async function awaitingRoot(
  executor: Executor,
  ticket: { id: string },
  openerMessageId: string | null,
): Promise<boolean> {
  if (!openerMessageId) return false;

  const [opener] = await executor
    .select({ inReplyTo: messages.inReplyTo })
    .from(messages)
    .where(eq(messages.id, openerMessageId));
  if (!opener?.inReplyTo) return false;

  const [root] = await executor
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
