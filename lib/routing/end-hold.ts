import { and, eq, ne, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { conversationEvents, conversations, groups, routingDecisions } from '@/db/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What ends a hold early: a person, or an automation rule, deciding where the
 * ticket goes before the router does (`plans/ticket-category-routing.md`,
 * decision 5).
 *
 * - **`manual`** — the console's group change, assignee change and agent
 *   reply. Whoever does any of those has decided for the ticket.
 * - **`rule`** — the engine's `assign_group` to another group, `auto_assign`
 *   naming another group, and `assign_agent` with an agent: only an action
 *   that changes something, compared against the locked row. A rule naming the
 *   group the ticket is in matches on every pass, and must not end every hold
 *   on its channel.
 *
 * Called in the transaction of the write that ends the hold, after that write
 * — the group it records is the one the write left — and before anything that
 * assigns. Safe on any ticket: one with no undecided routing row is left
 * alone, so the console can call it unconditionally.
 *
 * On a live row it ends the hold (`routing_decided_at`, set once) and records
 * the outcome only if phase one has not already — a person assigning between
 * the router's two phases does not rename the router's decision. A rule
 * between them ends nothing at all: the router is running the rules it owes
 * and ends the hold once the whole pass is over. On a shadow row it records
 * the would-be outcome: a person or a rule moving a ticket the router was only
 * watching is what the shadow period exists to measure.
 *
 * Answers whether it ended a live hold, which is what owes the held reply and
 * the assignment (`afterHoldEnded`) once the caller's transaction commits.
 */
export async function endHold(
  tx: Tx,
  conversationId: string,
  outcome: 'manual' | 'rule',
  actor: { agentId?: string | null; label?: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  // The ticket's row first, as every routing writer takes them, whether or not
  // the caller has already locked it by writing to it.
  const [ticket] = await tx
    .select({ groupId: conversations.groupId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
  if (!ticket) return false;

  const [row] = await tx
    .select({
      id: routingDecisions.id,
      shadow: routingDecisions.shadow,
      outcome: routingDecisions.outcome,
      fromGroupId: routingDecisions.fromGroupId,
      phaseOneAt: routingDecisions.phaseOneAt,
    })
    .from(routingDecisions)
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        ne(routingDecisions.stage, 'decided'),
      ),
    )
    .for('update');
  if (!row) return false;

  // Phase one has written the router's decision, and the rules now running are
  // the ones it waits for before it ends the hold itself (`lib/routing/apply.ts`)
  // — this pass, or one racing it. A rule's move there is part of that wait,
  // not a decision of its own. Ended here, the hold would let the next rule in
  // the same pass, a group-less `auto_assign`, hand the ticket to somebody in a
  // group a later rule then moves it out of — the cross-team holder the two
  // phases exist to prevent — and send the held reply before the pass had
  // chosen whose calendar it speaks for. A router that died there leaves the
  // hold to `settle_routing`, which completes the decision either way.
  if (outcome === 'rule' && row.phaseOneAt) return false;

  const first = row.outcome === null;
  await tx
    .update(routingDecisions)
    .set({
      stage: 'decided',
      decidedAt: sql`coalesce(${routingDecisions.decidedAt}, ${now.toISOString()}::timestamptz)`,
      ...(first
        ? {
            outcome,
            toGroupId: ticket.groupId,
            decidedByAgentId: actor.agentId ?? null,
            decidedByLabel: actor.label ?? null,
          }
        : {}),
    })
    .where(eq(routingDecisions.id, row.id));

  if (row.shadow) return false;

  const ended = await endHoldOnRow(tx, conversationId, now);

  if (first) {
    const [toGroup] = ticket.groupId
      ? await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, ticket.groupId))
      : [];
    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'routed',
      actorAgentId: actor.agentId ?? null,
      actorLabel: actor.agentId ? null : (actor.label ?? 'routing'),
      data: {
        outcome,
        from: row.fromGroupId,
        to: ticket.groupId,
        toName: toGroup?.name ?? null,
        moved: ticket.groupId !== row.fromGroupId,
      },
    });
  }

  return ended;
}

/**
 * The ticket's half of ending a hold: `routing_decided_at`, set once and never
 * moved, so a hold once over never comes back. The caller holds the row lock.
 */
export async function endHoldOnRow(tx: Tx, conversationId: string, now: Date): Promise<boolean> {
  const ended = await tx
    .update(conversations)
    .set({ routingDecidedAt: now })
    .where(
      and(eq(conversations.id, conversationId), sql`${conversations.routingDecidedAt} is null`),
    )
    .returning({ id: conversations.id });
  return ended.length > 0;
}
