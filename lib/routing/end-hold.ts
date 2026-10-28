import { and, eq, ne, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { conversationEvents, conversations, groups, routingDecisions } from '@/db/schema';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What ends a hold early: a person, or an automation rule, deciding where the
 * ticket goes before the router does (`plans/ticket-category-routing.md`,
 * decision 5).
 *
 * - **`manual`** — the console's group change and assignee change, an agent's
 *   reply, and Hand to. Whoever does any of those has decided for the ticket.
 * - **`rule`** — the engine's `assign_group` to another group, `auto_assign`
 *   naming another group, and `assign_agent` with an agent: only an action
 *   that changes something, compared against the locked row. A rule naming the
 *   group the ticket is in matches on every pass, and must not end every hold
 *   on its channel.
 *
 * Called in the transaction of the write that ends the hold, after that write
 * — the group it records is the one the write left — and before anything that
 * assigns. Safe on any ticket: one with no undecided routing row is left
 * alone, without so much as a lock, so the console can call it
 * unconditionally.
 *
 * On a live row it ends the hold (`routing_decided_at`, set once) and records
 * the outcome — unless phase one has already written the router's decision.
 * That decision is the router's to finish, whoever acts meanwhile, person or
 * rule: this then decides nothing, ends nothing and records nothing, and the
 * caller's own write simply stands (`lib/routing/apply.ts`). On a shadow row
 * it records the would-be outcome: a person or a rule moving a ticket the
 * router was only watching is what the shadow period exists to measure.
 *
 * `actor.decidesShadow: false` is for a write that ends a live hold but says
 * nothing about where a ticket goes — an agent's reply. On a shadow row the
 * rota assigned the ticket on arrival, which a live hold would have
 * prevented, so that agent answering it is no decision the live mode would
 * have seen, and counting it as `manual` would inflate exactly the figure the
 * shadow week is read for.
 *
 * Answers whether it ended a live hold, which is what owes the held reply and
 * the assignment (`afterHoldEnded`) once the caller's transaction commits. A
 * decision in flight answers false, so the caller pays none of that: the
 * router's own end of the hold does, after its rules.
 */
export async function endHold(
  tx: Tx,
  conversationId: string,
  outcome: 'manual' | 'rule',
  actor: { agentId?: string | null; label?: string | null; decidesShadow?: boolean },
  now: Date = new Date(),
): Promise<boolean> {
  // The routing row first, read without a lock, so a ticket that never routed
  // — nearly every ticket — takes no lock here at all. An answer of none cannot
  // go stale: the row is born in the ticket's own insert transaction, which has
  // committed by the time anybody can write to the ticket, and once decided it
  // is never undecided again.
  const [undecided] = await tx
    .select({ id: routingDecisions.id })
    .from(routingDecisions)
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        ne(routingDecisions.stage, 'decided'),
      ),
    );
  if (!undecided) return false;

  // Then the ticket's row and its routing row, in the order every routing
  // writer takes them, and the routing row read again under them: somebody may
  // have decided it since the read above.
  //
  // NO KEY UPDATE, never UPDATE. The caller has already written to the row,
  // which holds NO KEY UPDATE, and this asks for nothing more. FOR UPDATE would
  // upgrade it, and FOR UPDATE conflicts with the KEY SHARE that a customer's
  // message holds on its ticket through the foreign key from the moment it is
  // inserted. Every ingest path inserts the message and then updates the
  // ticket, in one transaction: waiting here on its KEY SHARE while it waits on
  // the caller's write is a deadlock, and Postgres aborts one of the two — an
  // agent's reply stored and never sent, or the customer's message lost. NO
  // KEY UPDATE still serialises against every other writer of the row.
  const [ticket] = await tx
    .select({ groupId: conversations.groupId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('no key update');
  if (!ticket) return false;

  const [row] = await tx
    .select({
      id: routingDecisions.id,
      shadow: routingDecisions.shadow,
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

  // Phase one has written the router's decision, and what it owes — the
  // category's rules (phase two), then the hold's end (phase three), then the
  // policy's second look and the assignment — is the router's to finish, in
  // that order, whoever acts meanwhile. The caller's own write stands: a reply
  // is stored, a named assignee is set (which ends `isHeld` on its own), a
  // person's move is where the router's assignment then looks. What it does
  // not do is end the hold.
  //
  // Ended here by a rule, the next rule in the same pass — a group-less
  // `auto_assign` — would hand the ticket to somebody in a group a later rule
  // then moves it out of: the cross-team holder the two phases exist to
  // prevent, and the held reply sent before the pass had chosen whose
  // calendar it speaks for. Ended by a person — an agent's reply, the
  // console's group or assignee case, Hand to — the caller's `afterHoldEnded`
  // assigned before the router's rules had run, and the same holder followed:
  // `assign_group` never touches an assignee. Nor may it decide the row and
  // leave the router its outcome, as it once did for a person: the window's
  // job never resumes a decided row, so a router that stalled then ran its
  // rules on a ticket resolved meanwhile when it woke, and one whose claim on
  // the pass failed left the pass owed for good.
  //
  // So it stays the router's. A router that died here, or whose last step
  // failed, leaves the hold to `settle_routing`, which completes the decision
  // once phase one is a minute old (`PHASE_ONE_RESUME_MS`): the window's job,
  // still to come, when the router was anything else, and the job retrying
  // itself when it was the router (`settleRouting`).
  if (row.phaseOneAt) return false;
  if (row.shadow && actor.decidesShadow === false) return false;

  // The outcome is this one's, always: the only other writer of an outcome on
  // an undecided row is phase one, whose row the line above has left alone.
  await tx
    .update(routingDecisions)
    .set({
      stage: 'decided',
      decidedAt: sql`coalesce(${routingDecisions.decidedAt}, ${now.toISOString()}::timestamptz)`,
      // A rule's strategy waiting for the hold is superseded: whoever ended it
      // has decided how the ticket goes on, and a grouped `auto_assign` that
      // ended it picks with its own strategy straight away (`assignConversation`).
      heldStrategy: null,
      heldActorLabel: null,
      outcome,
      toGroupId: ticket.groupId,
      decidedByAgentId: actor.agentId ?? null,
      decidedByLabel: actor.label ?? null,
    })
    .where(eq(routingDecisions.id, row.id));

  if (row.shadow) return false;

  const ended = await endHoldOnRow(tx, conversationId, now);

  const [toGroup] = ticket.groupId
    ? await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, ticket.groupId))
    : [];
  await tx.insert(conversationEvents).values({
    conversationId,
    type: 'routed',
    // After the write that ended the hold, which may stamp its own event the
    // same way: the transaction's start would sort this before it.
    createdAt: CHANGE_STAMP,
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
