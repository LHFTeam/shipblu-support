import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, messages, routingDecisions } from '@/db/schema';
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
 * Jev's own events say which message each of its answers was about: the
 * `category_changed` a write leaves names the message, and so does the
 * `category_agreed` an answer naming the category the ticket already carries
 * leaves in its place (`categoryAgreedEvent`) — the customer's root answering
 * what the replier's reply was read as, which wrote nothing.
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
): Promise<{ byJev: boolean; eventId: string } | null> {
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
      requesterContactId: conversations.requesterContactId,
      channel: conversations.channel,
      externalId: conversations.externalId,
    })
    .from(routingDecisions)
    .innerJoin(conversations, eq(conversations.id, routingDecisions.conversationId))
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
 * Whether a confident answer of the requester's, naming the category her
 * ticket already carries, is the first word of hers on a category the window's
 * end set aside, with nothing having re-chosen the policy since. Such an answer
 * writes nothing but its `category_agreed` (`categoryAgreedEvent`), and the
 * set-aside chose no policy for the category (`categoryStanding`): her answer
 * makes the category hers, and is owed the policy's look a write would have had
 * (`afterCategoryConfirmed`).
 *
 * Only while that look is still owed. Everywhere else the category already had
 * its look, and a second one owed for nothing takes up whatever has moved
 * since — a priority her opening lowered, or one a later message raised, which
 * by rule re-chooses no policy (`onPriorityChanged`) — as though the category
 * had changed. So:
 *
 * - the ticket's live decision is a `fallback` whose `routed` line names this
 *   very category under `setAside` — not a ticket that never routed, whose
 *   passer-by's write relabelled it, nor a decision that routed on his
 *   reading, nor a shadow row, each of which looked;
 * - nothing has re-chosen the policy since that line: no move (a person's,
 *   Hand to's or a rule's, each of which re-chooses it with the category on
 *   the ticket and writes its `group_changed`), no category write, and no
 *   `sla_recalculated`;
 * - and no other agreement came between that line and this one. Her later
 *   messages are `after_settle` once one settles, but an earlier one answered
 *   late is answered again (`ticketFacts`), and the first of the two to land
 *   is the one owed the look. Both stamps are taken under the ticket's lock
 *   (`CHANGE_STAMP`), so which was first does not depend on which answer's
 *   follow-up runs first: two landing a moment apart, each read after both
 *   had committed, give the look once. Every agreement after the line is hers:
 *   the root had arrived by then, or never will, and a passer-by's answers are
 *   never applied once she is the requester (`skipReason`).
 *
 * A hold a person or a rule ended without moving the ticket — the console's
 * assignee case, an agent's reply, an `assign_agent` rule — while the words
 * were still the replier's is not reached: its category keeps the policy
 * chosen before it, until a move or the next writer re-chooses it (AGENTS.md,
 * the costs).
 */
export async function setAsideCategoryAgreed(
  conversationId: string,
  agreedEventId: string,
): Promise<boolean> {
  const [aside] = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .innerJoin(routingDecisions, eq(routingDecisions.conversationId, conversations.id))
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'routed'),
        eq(routingDecisions.shadow, false),
        eq(routingDecisions.stage, 'decided'),
        eq(routingDecisions.outcome, 'fallback'),
        sql`${conversationEvents.data}->'setAside'->>'categoryId' = ${conversations.categoryId}::text`,
      ),
    )
    .limit(1);
  if (!aside) return false;

  // Compared in the database, to the microsecond `clock_timestamp()` keeps, as
  // `jevCategoryOwed` compares its two stamps.
  const asideAt = sql`(select decided.created_at from conversation_events decided where decided.id = ${aside.id})`;
  const agreedAt = sql`(select agreed.created_at from conversation_events agreed where agreed.id = ${agreedEventId})`;
  const [since] = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        sql`${conversationEvents.createdAt} > ${asideAt}`,
        sql`(${conversationEvents.type} in ('group_changed', 'category_changed', 'sla_recalculated') or (${conversationEvents.type} = 'category_agreed' and ${conversationEvents.createdAt} < ${agreedAt}))`,
      ),
    )
    .limit(1);
  return !since;
}

/**
 * Whether some answer of Jev's that chose the ticket's category — a write that
 * put it there, or an answer agreeing with it — was about a message nobody
 * other than the requester wrote (`writtenByAnother`).
 */
async function requesterChose(
  executor: Executor,
  ticket: { id: string; categoryId: string | null; requesterContactId: string | null },
): Promise<boolean> {
  if (!ticket.requesterContactId) return true;

  const answers = await executor
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, ticket.id),
        inArray(conversationEvents.type, ['category_changed', 'category_agreed']),
        eq(conversationEvents.actorLabel, CATEGORY_AI_ACTOR),
      ),
    );
  const answered = answers
    .filter((answer) => answer.data.to === ticket.categoryId)
    // Spelled as the database spells an id, as `ticketFacts` reads the same
    // field: a job run by hand with an upper-case id writes it so, and would
    // otherwise name no message the lookup below finds. An id that is not one
    // names no message, and so counts as the requester's, rather than refusing
    // the whole decision with 22P02.
    .map((answer) => canonicalUuid(answer.data.messageId));

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
