import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, conversations, contacts, messages, ticketStatuses } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { hiddenChannels, restrictedChannels } from './channel-policy';
import { rootCommentId } from '@/lib/meta/comments';
import { sbidMatches, trackingMatches } from '@/lib/shipments/queries';
import { cleanQuery } from '@/lib/search/text';
import { parseSearchTerm } from './search';
import { type InboxCursor, type InboxFilters, PAGE_SIZE, encodeInboxCursor } from './inbox-filters';

/**
 * Read models for the console.
 *
 * Kept apart from the write path so a page renders from one query per pane
 * rather than an ORM graph walk — the inbox is the most-loaded screen in the
 * product and the difference is visible.
 */

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
  /**
   * A Facebook or Instagram comment ticket, answered on the comment edge rather
   * than in a messaging window. The list reads it so it does not badge a window
   * the ticket has not got; the header asks the same question of the same
   * `external_id`.
   */
  isComment: boolean;
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
 * The list's row, with the joins every row needs. Shared by the paged query and
 * the lookup of a ticket named by number, so the one put first cannot be
 * missing a field its neighbours carry.
 */
function selectInboxRows(where: SQL | undefined) {
  return db
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
      externalId: conversations.externalId,
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
    .where(where);
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

  // Everything but the search. The ticket a query names by number is read under
  // exactly these, so naming it cannot reach one the filters or visibility keep
  // out of the list.
  const filtered = [...where];
  let namedNumber: number | null = null;

  // Cleaned before the check rather than after: a query that is only a pasted
  // U+200F, a tatweel or a fatha cleans to '', and searching for '' matched
  // every ticket with any text on it — and ran both EXISTS scans over the
  // messages to do it — while dropping the one ticket that has none.
  const query = cleanQuery(filters.q);

  if (query) {
    const { pattern, arabicPattern, number, phonePattern, trackingNumber, sbid, scope } =
      parseSearchTerm(query);

    // A prefixed query is narrowed to its one clause. That is what makes typing
    // `track:` worth doing — the alternative ORs it into a list that still has
    // to consider every message body in the account.
    if (scope === 'tracking' && trackingNumber) {
      where.push(trackingMatches(trackingNumber));
    } else if (scope === 'sbid' && sbid) {
      where.push(sbidMatches(sbid));
    } else {
      // The columns people write Arabic in. A query holding a letter Arabic
      // spells several ways is matched as a regular expression widened to all of
      // them, and anything else keeps the ILIKE it always had; the same trigram
      // index serves both. Email and phone never hold Arabic, so they stay ILIKE.
      const written = (column: AnyColumn | SQL): SQL =>
        arabicPattern ? sql`${column} ~* ${arabicPattern}` : sql`${column} ILIKE ${pattern}`;

      const clauses: SQL[] = [
        written(conversations.subject),
        written(contacts.name),
        ilike(contacts.primaryEmail, pattern),
        ilike(contacts.primaryPhone, pattern),
        // What was actually said. Subjects on the messaging channels are picked
        // from a short list of canned categories, so hundreds of tickets share
        // one — searching them finds a category, never a conversation. The
        // tracking number or the sentence the agent half-remembers is in the
        // messages, which is where a search of a chat has to look.
        sql`EXISTS (
          SELECT 1 FROM ${messages} m
          WHERE m.conversation_id = ${conversations.id} AND ${written(sql`m.body_text`)}
        )`,
        // And what the hub said. Often the only place the actual explanation
        // lives — "driver attempted twice, phone off" is written by somebody who
        // never appears on the ticket timeline, and it is what an agent
        // half-remembers weeks later. Only agents ever read this table, so
        // searching it raises no visibility question.
        sql`EXISTS (
          SELECT 1 FROM side_conversations sc
          JOIN side_conversation_messages sm ON sm.side_conversation_id = sc.id
          WHERE sc.conversation_id = ${conversations.id} AND ${written(sql`sm.body_text`)}
        )`,
      ];

      if (phonePattern) clauses.push(ilike(contacts.primaryPhone, phonePattern));

      // The body search above already finds tickets that *mention* a number.
      // These two add every ticket that is *about* the shipment: the reply that
      // never quoted it, the one an agent linked by hand, the one where it
      // appeared only in a private note.
      if (trackingNumber) clauses.push(trackingMatches(trackingNumber));
      if (sbid) clauses.push(sbidMatches(sbid));

      where.push(or(...clauses)!);

      // "#812" and a bare "812" both name ticket 812, but the bare one also
      // matches every phone and message holding those digits — 394 tickets for
      // 812 in production — and in recency order the ticket it named can be
      // pages down. So that ticket is read on its own and put first, and kept
      // out of the paged query so no page shows it twice. On its own rather than
      // as a leading sort key: the cursor below compares the timestamp and the
      // id and nothing else, so a ticket sorted to the top of page one by some
      // other key would come back on whichever later page its timestamp is on.
      if (number !== null) {
        namedNumber = number;
        where.push(ne(conversations.number, number));
      }
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

  const [rows, named] = await Promise.all([
    selectInboxRows(and(...where))
      // The id is part of the sort, not decoration: without a total order, two
      // rows sharing a timestamp could come back in either order and the cursor
      // would step over one of them.
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      // One extra row is the cheapest way to know whether a next page exists.
      .limit(PAGE_SIZE + 1),
    // For the first page, which it leads. The paged query excludes it on every
    // page, so no later one brings it back.
    namedNumber !== null && !cursor
      ? selectInboxRows(and(...filtered, eq(conversations.number, namedNumber))).limit(1)
      : [],
  ]);

  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];

  return {
    // A cursor only when there is more to fetch, so "no cursor" is the single
    // signal for "end of list" and the client needs no second flag.
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? encodeInboxCursor({ time: last.cursorTime, id: last.id })
        : null,
    rows: [...named, ...page].map((row) => ({
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
      isComment: rootCommentId(row.externalId) !== null,
      tags: row.tags,
      preview: row.preview,
      sideState: row.sideState === 'replied' || row.sideState === 'waiting' ? row.sideState : null,
    })),
  };
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
