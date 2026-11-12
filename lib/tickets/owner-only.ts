import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, channels, conversations } from '@/db/schema';
import { can, type AgentRole } from '@/lib/auth/permissions';

/**
 * A coexistence number's tickets are its owner's alone.
 *
 * A coexistence number is one team member's phone: the chats on it are typed
 * there, and its copied history is six months of that phone's conversations.
 * So a ticket on one is seen by the number's owner and by an agent who sees
 * every ticket (`ticket.view.all`), and by nobody else: not the members of the
 * group it sits in, not a colleague it was assigned to, not the previous owner
 * it is still accountable to. With no owner — or a deactivated one, who cannot
 * sign in — that leaves the agents who see every ticket.
 *
 * Reading is one predicate (`heldByOrInGroupsOf`, which asks
 * `notOnCoexistenceNumber`). This module is also what the writers ask, because
 * a rule about who may see a ticket is a rule about who may hold it: a ticket
 * assigned to somebody it is hidden from is in nobody's list, counts against
 * their capacity, and reads as taken to everybody who can see it. So the rota
 * never picks for one (`assignConversation`), and the console, a rule, a
 * handover and a reopen leave one only with somebody `seesOwnerOnlyTicket`
 * admits.
 */

/**
 * A `channels` row that is a coexistence number, as SQL.
 *
 * Any object under `coexistence` counts, which is what
 * `lib/whatsapp/coexistence-state.ts` asks too and is looser than
 * `parseCoexistence`, which also wants its `onboardedAt` and `wabaId`. The
 * difference is a row somebody wrote by hand, and for a rule that hides
 * tickets the side to be wrong on is hiding them. A disconnected number still
 * counts: its tickets are still that phone's chats.
 */
export function isCoexistenceNumber(): SQL {
  return and(
    eq(channels.type, 'whatsapp'),
    sql`jsonb_typeof(${channels.config} -> 'coexistence') = 'object'`,
  )!;
}

const coexistenceNumbers = () =>
  db.select({ id: channels.id }).from(channels).where(isCoexistenceNumber());

/**
 * Whether a conversation is on a coexistence number, as a condition on
 * `conversations` that needs no join: the callers of the visibility predicate
 * join different tables, and several join none.
 *
 * Against a list read once per statement — `= any(array(…))`, an InitPlan — as
 * `movesWithNumber` does and for its reasons: never turned into a join, so a
 * caller that locks the ticket's row re-checks a value rather than a joined
 * row, and one read however many tickets the statement looks at. There are a
 * handful of numbers and every inbox render asks.
 */
export function onCoexistenceNumber(): SQL {
  return sql`${conversations.channelId} = any(array(${coexistenceNumbers()}))`;
}

/**
 * The negative, spelled out rather than `not (…)`: most tickets have no
 * `channel_id` at all — every email, Meta and web chat ticket, and a WhatsApp
 * number no row names — and `null = any(…)` is null, which `not` leaves null
 * and a `where` reads as false. Negated the short way, every ticket off
 * WhatsApp vanished for every agent the moment one coexistence number existed.
 */
export function notOnCoexistenceNumber(): SQL {
  return sql`(${conversations.channelId} is null or ${conversations.channelId} <> all(array(${coexistenceNumbers()})))`;
}

/** What an agent is told when they give one to somebody it is hidden from. */
export const OWNER_ONLY_REFUSAL =
  'Only the owner of this WhatsApp number, a supervisor or an admin can open its tickets, so it cannot be assigned to anybody else.';

/** What `seesOwnerOnlyTicket` needs of an agent. */
export type Holder = { id: string; role: AgentRole; permissions: Record<string, boolean> };

/**
 * Whether an agent sees a ticket on a coexistence number owned by `ownerId` —
 * the JavaScript twin of the predicate's two ways in, for a writer deciding
 * whether somebody may be left holding one.
 */
export function seesOwnerOnlyTicket(agent: Holder, ownerId: string | null): boolean {
  return agent.id === ownerId || can(agent, 'ticket.view.all');
}

/**
 * The active agents who see every ticket, by id: who, beside its owner, a
 * coexistence number's ticket may stay with when the number changes hands.
 *
 * Read whole and filtered here, because `can()` is the one statement of what a
 * role holds and what an agent's own overrides add or take away, and a second
 * copy of it in SQL would be the one that drifts.
 */
export async function agentsWhoSeeEveryTicket(tx: Pick<typeof db, 'select'>): Promise<Set<string>> {
  const rows = await tx
    .select({ id: agents.id, role: agents.role, permissions: agents.permissions })
    .from(agents)
    .where(eq(agents.isActive, true));
  return new Set(rows.filter((row) => can(row, 'ticket.view.all')).map((row) => row.id));
}

/**
 * Whether a channel row is a coexistence number, and who owns it: read by a
 * writer about to assign one of its tickets.
 */
export async function ownerOnlyNumber(
  tx: Pick<typeof db, 'select'>,
  channelId: string | null,
): Promise<{ ownerId: string | null } | null> {
  if (!channelId) return null;
  const [row] = await tx
    .select({ ownerId: channels.ownerAgentId })
    .from(channels)
    .where(and(eq(channels.id, channelId), isCoexistenceNumber()));
  return row ?? null;
}

/**
 * Whether a ticket on `channelId` would be hidden from `agentId` were they
 * given it — for a writer that has only the two ids, as a rule's
 * `assign_agent` does. False off a coexistence number, and for an agent who is
 * gone, whom the foreign key answers for. An agent who sees every ticket but
 * is deactivated is not hidden from: what a deactivated agent holds is every
 * ticket's question, not this rule's.
 */
export async function hiddenFromHolder(
  tx: Pick<typeof db, 'select'>,
  channelId: string | null,
  agentId: string,
  ownerId?: string | null,
): Promise<boolean> {
  const number = await ownerOnlyNumber(tx, channelId);
  if (!number) return false;
  const [agent] = await tx
    .select({ id: agents.id, role: agents.role, permissions: agents.permissions })
    .from(agents)
    .where(eq(agents.id, agentId));
  // The owner a caller has already read under the number's lock, where it
  // has one: a deactivated owner counts as nobody there (`effectiveOwnerId`).
  const owner = ownerId === undefined ? number.ownerId : ownerId;
  return agent ? !seesOwnerOnlyTicket(agent, owner) : false;
}
