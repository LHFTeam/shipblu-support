import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { db } from '@/db/client';
import { agents, conversationEvents, conversations } from '@/db/schema';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { ownerOnlyNumber, seesOwnerOnlyTicket } from '@/lib/tickets/owner-only';

/**
 * The one writer of `conversations.assignee_agent_id`.
 *
 * A coexistence number's tickets are seen by the number's owner and by the
 * agents who see every ticket, and by nobody else (`lib/tickets/owner-only.ts`),
 * and a rule about who may see a ticket is a rule about who may hold it: a
 * ticket assigned to somebody it is hidden from is in nobody's list, counts
 * against their capacity, and reads as taken to everybody who can see it. That
 * was asked writer by writer — the rota, the console, a rule, a handover, a
 * reopen — and so not asked by the writers nobody thought of: a ticket adopted
 * onto a coexistence row while a colleague held it kept the colleague. Every
 * write of the column is here now, and the `assignee-confinement` repo rule
 * refuses one anywhere else, so a new writer cannot forget the question.
 *
 * Not a database trigger, on purpose: "sees every ticket" is `can()` over a
 * role and an agent's own overrides (`lib/auth/permissions.ts`), and a copy of
 * it in SQL is the one that drifts.
 *
 * A write takes two steps, because of the order locks are taken in. A handover
 * locks the number's row and then its tickets' (`handOverNumber`), so a writer
 * that held a ticket's row and then asked the number would wait on a handover
 * waiting on it. So:
 *
 *  1. `lockHolders(tx, channelId)` — or `lockHoldersOf(tx, conversationId)`,
 *     which reads the ticket's number first — before the transaction locks or
 *     writes the ticket's row. It reads who may hold a ticket on that number, under the
 *     lock a handover waits for (FOR KEY SHARE on the channel), so the answer
 *     holds until the transaction ends.
 *  2. `assignTicket(tx, holders, …)`, which refuses an agent the ticket would
 *     be hidden from and writes only while the ticket is still on the number
 *     step 1 asked about — the channel is part of the write's own `where`, so a
 *     ticket adopted onto another row between the two is not written at all.
 *
 * Giving a ticket to nobody needs neither: nobody is always somebody a ticket
 * may be left with (`unassignTicket`).
 *
 * Each caller still writes its own line on the timeline and keeps its own
 * guards (`onlyIf`): what an assignment means differs by writer, and who may
 * hold the ticket does not.
 */

type Executor = Pick<typeof db, 'select' | 'update' | 'insert'>;

declare const holdersBrand: unique symbol;

/**
 * Who may hold a ticket on one number, as `lockHolders` read it. Only that
 * function makes one, so an assignment cannot be checked against an owner
 * somebody read outside the transaction, or not under the number's lock.
 */
export type Holders = {
  readonly [holdersBrand]: true;
  /** The `channels` row the answer is about; null for a ticket under no row. */
  readonly channelId: string | null;
  /**
   * Set on a coexistence number, whose tickets are its owner's alone: the
   * owner while they are active, or null. A deactivated owner counts as nobody
   * (`effectiveOwnerId`): they cannot sign in, so they see nothing.
   */
  readonly ownerOnly: { readonly ownerId: string | null } | null;
};

/**
 * Who may hold a ticket on `channelId`, read under the number's lock.
 *
 * Call it inside the transaction that assigns, and before that transaction
 * locks or writes the ticket's row: the channel first, then the ticket, the
 * order a handover takes them. A transaction that already holds the channel's
 * lock (`lockedOwnerId`, or the handover's own FOR UPDATE) may call it at any
 * point, since it then waits for nobody.
 *
 * Only a coexistence row is locked (`ownerOnlyNumber`), and a ticket under no
 * row reads nothing: every other number's tickets may be held by anybody.
 */
export async function lockHolders(tx: Executor, channelId: string | null): Promise<Holders> {
  const number = await ownerOnlyNumber(tx, channelId, { lock: true });
  if (!number) return { channelId, ownerOnly: null } as Holders;

  // The owner's activity in a second read, never joined to the locked row
  // (`lockedOwnerId` says why).
  const [owner] = number.ownerId
    ? await tx.select({ active: agents.isActive }).from(agents).where(eq(agents.id, number.ownerId))
    : [];
  return {
    channelId,
    ownerOnly: { ownerId: owner?.active ? number.ownerId : null },
  } as Holders;
}

/**
 * `lockHolders` for the number a ticket is on now, for a writer that has only
 * the ticket's id — or only a copy of its row read some time ago, which is the
 * same thing: a ticket under no row is filed under one by its customer's next
 * message (`fileUnderNumber`), and a writer that asked about the number its
 * copy named would be told `missed` for an assignment nothing was wrong with.
 *
 * The ticket's row is read here and not locked, so the channel's lock still
 * comes first. A ticket filed in the moment between this read and the write
 * is still caught by the write's own `where`.
 */
export async function lockHoldersOf(tx: Executor, conversationId: string): Promise<Holders> {
  const [ticket] = await tx
    .select({ channelId: conversations.channelId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return lockHolders(tx, ticket?.channelId ?? null);
}

/**
 * Whether `agentId` may be left holding a ticket on the number `holders` is
 * about. True off a coexistence number, and for an agent who is gone, whom the
 * foreign key answers for; false for somebody who cannot sign in, whatever
 * their role says, as `agentsWhoSeeEveryTicket` leaves them out.
 */
export async function admits(tx: Executor, holders: Holders, agentId: string): Promise<boolean> {
  if (!holders.ownerOnly) return true;
  const [agent] = await tx
    .select({
      id: agents.id,
      role: agents.role,
      permissions: agents.permissions,
      isActive: agents.isActive,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) return true;
  if (!agent.isActive) return false;
  return seesOwnerOnlyTicket(agent, holders.ownerOnly.ownerId);
}

/** The ticket is still on the number `holders` was read for. */
const onNumber = (holders: Holders): SQL =>
  holders.channelId === null
    ? isNull(conversations.channelId)
    : eq(conversations.channelId, holders.channelId);

/**
 * What an assignment answered:
 *
 * - `assigned`: written.
 * - `hidden`: refused, nothing written. The ticket is on a coexistence number
 *   and `to` is neither its owner nor an agent who sees every ticket.
 * - `missed`: nothing written, because no row matched. The caller's own
 *   `onlyIf` failed, the ticket is gone, or it is no longer on the number
 *   `holders` was read for.
 */
export type Assigned = 'assigned' | 'hidden' | 'missed';

/**
 * Give a ticket to `to`, at `at`.
 *
 * `onlyIf` is the caller's own guard, ANDed into the write: the rota's "still
 * held by nobody", for one.
 */
export async function assignTicket(
  tx: Executor,
  holders: Holders,
  input: { conversationId: string; to: string; at: Date; onlyIf?: SQL },
): Promise<Assigned> {
  if (!(await admits(tx, holders, input.to))) return 'hidden';
  const written = await tx
    .update(conversations)
    .set({ assigneeAgentId: input.to, assignedAt: input.at })
    .where(and(eq(conversations.id, input.conversationId), onNumber(holders), input.onlyIf))
    .returning({ id: conversations.id });
  return written.length > 0 ? 'assigned' : 'missed';
}

/**
 * Give several tickets on one number to `to` in one statement, as a handover
 * does. One answer for all of them, since they share the number and the
 * agent; the ids written are returned.
 */
export async function assignTickets(
  tx: Executor,
  holders: Holders,
  input: { conversationIds: string[]; to: string; at: Date },
): Promise<{ refused: 'hidden' | null; written: string[] }> {
  if (input.conversationIds.length === 0) return { refused: null, written: [] };
  if (!(await admits(tx, holders, input.to))) return { refused: 'hidden', written: [] };
  const written = await tx
    .update(conversations)
    .set({ assigneeAgentId: input.to, assignedAt: input.at })
    .where(and(inArray(conversations.id, input.conversationIds), onNumber(holders)))
    .returning({ id: conversations.id });
  return { refused: null, written: written.map((row) => row.id) };
}

/**
 * Give a ticket to nobody, which every ticket allows. Whether a row was
 * written: `onlyIf` is the caller's guard, as the reclaim's "still held by the
 * agent the sweep read".
 */
export async function unassignTicket(
  tx: Executor,
  input: { conversationId: string; onlyIf?: SQL },
): Promise<boolean> {
  const written = await tx
    .update(conversations)
    .set({ assigneeAgentId: null, assignedAt: null })
    .where(and(eq(conversations.id, input.conversationId), input.onlyIf))
    .returning({ id: conversations.id });
  return written.length > 0;
}

/** `unassignTicket` for several tickets in one statement, as a handover does. */
export async function unassignTickets(tx: Executor, conversationIds: string[]): Promise<void> {
  if (conversationIds.length === 0) return;
  await tx
    .update(conversations)
    .set({ assigneeAgentId: null, assignedAt: null })
    .where(inArray(conversations.id, conversationIds));
}

/**
 * The columns a ticket created on a number starts with: accountable to the
 * owner and assigned to them, at `at` — or neither, with no owner.
 *
 * `ownerId` is the number's owner as `lockedOwnerId` read it inside the
 * insert's transaction, and the owner is somebody every number's ticket may be
 * left with, so an insert asks nothing more.
 *
 * Written in the insert rather than by the assignment that follows it, because
 * an `on_create` rule must see the ticket the team actually has, and because a
 * ticket the business opened from the phone is resolved on creation and never
 * reaches `assignConversation` at all. `autoAssign` then finds it assigned and
 * stops there.
 */
export function ownerStamp(
  ownerId: string | null,
  at: Date,
): {
  accountableAgentId: string | null;
  assigneeAgentId: string | null;
  assignedAt: Date | null;
} {
  return ownerId
    ? { accountableAgentId: ownerId, assigneeAgentId: ownerId, assignedAt: at }
    : { accountableAgentId: null, assigneeAgentId: null, assignedAt: null };
}

/**
 * File a ticket that sits under no row under `channelId`, and take it off a
 * holder it is hidden from there.
 *
 * Putting a ticket on a number is a write about who may hold it as much as an
 * assignment is: on a coexistence row, the colleague who held it while it was
 * nobody's number's would keep a ticket that has just left every list of
 * theirs. It is given to nobody, with a line saying why, and the caller
 * assigns it once its transaction commits (`assignConversation`, which asks
 * the number's owner first).
 *
 * The channel's lock, then the ticket's, as everywhere; NO KEY UPDATE, as
 * every lock on a ticket's row is. Whether the ticket was filed, and whether
 * it lost its holder: a ticket somebody else filed meanwhile is left alone.
 */
export async function fileUnderNumber(
  tx: Executor,
  input: { conversationId: string; channelId: string },
): Promise<{ filed: boolean; unassigned: boolean }> {
  const holders = await lockHolders(tx, input.channelId);
  const [ticket] = await tx
    .select({ assigneeAgentId: conversations.assigneeAgentId })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), isNull(conversations.channelId)))
    .for('no key update');
  if (!ticket) return { filed: false, unassigned: false };

  const stranded =
    ticket.assigneeAgentId !== null && !(await admits(tx, holders, ticket.assigneeAgentId));

  await tx
    .update(conversations)
    .set({
      channelId: input.channelId,
      ...(stranded ? { assigneeAgentId: null, assignedAt: null } : {}),
    })
    .where(eq(conversations.id, input.conversationId));

  if (stranded) {
    await tx.insert(conversationEvents).values({
      conversationId: input.conversationId,
      type: 'unassigned',
      actorLabel: 'number_owner',
      createdAt: CHANGE_STAMP,
      data: {
        to: null,
        from: ticket.assigneeAgentId,
        reason: 'filed_under_number',
        channelId: input.channelId,
      },
    });
  }
  return { filed: true, unassigned: stranded };
}
