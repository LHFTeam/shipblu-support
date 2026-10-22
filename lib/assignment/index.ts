import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  conversationEvents,
  conversations,
  contacts,
  groupMembers,
  groups,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { isWithinBusinessHours } from '@/lib/hours';
import { groupHours } from '@/lib/hours/resolve';
import { conversationFacts } from '@/lib/rules/facts';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { openBacklog } from '@/lib/tickets/backlog';
import { recordOwnerAssigned } from '@/lib/whatsapp/number-owner';
import { filterCandidates, type CandidateRow } from './eligibility';
import { pickLoadBalanced, pickRoundRobin } from './strategies';
import { activeSkills, matchingSkills } from './skills';

/**
 * Handing a ticket to a person.
 *
 * Three rules hold on every path through this module.
 *
 * **It never overwrites an existing assignee.** Every entry point is guarded on
 * `assignee_agent_id IS NULL`. That single invariant is what makes a reopened
 * ticket stick to the agent who handled it — the column is not cleared on reopen
 * — and what stops the five-minute sweep from shuffling live work under people
 * who are part-way through answering it.
 *
 * **It never re-enters the automation engine.** Like every automation action, it
 * writes the ticket directly. Assignment triggering a rule that triggers an
 * assignment is the loop this codebase already decided not to have.
 *
 * **A refusal is recorded.** "Why is this ticket still unassigned?" is the
 * question a queue that assigns itself has to be able to answer, so a skipped
 * assignment writes its reason onto the timeline rather than returning silently.
 *
 * One kind of ticket skips the rota altogether: one on a WhatsApp number that
 * belongs to a person, whose `accountable_agent_id` names them
 * (`lib/whatsapp/number-owner.ts`). An unassigned one goes straight back to that
 * person while they are active — which is what makes "Unassign" on it hand it
 * back to the owner, and the sweep return a ticket reclaimed from somebody else.
 * The group, its strategy and hours, and the owner's presence, capacity and
 * skills are not consulted, and the group's round-robin cursor does not move:
 * every one of those gates measures who is at the console, and the owner
 * answers from the phone with it closed. A caller that named a group still
 * moves the ticket there first, because a rule routing it is describing where
 * the work belongs whoever then holds it. A deactivated owner is nobody here,
 * and the ticket takes the rota like any other.
 */

export type AssignmentStrategy = (typeof groups.$inferSelect)['assignmentStrategy'];

export type SkipReason =
  | 'already_assigned'
  | 'not_assignable'
  | 'no_group'
  | 'strategy_manual'
  | 'outside_hours'
  | 'no_group_members'
  | 'none_available'
  | 'all_at_capacity'
  | 'no_skill_match';

export type AssignmentOutcome = {
  assignedTo: string | null;
  reason: SkipReason | null;
};

/** Reasons worth a timeline entry. The rest are "this ticket is not ours to route". */
const WORTH_RECORDING: ReadonlySet<SkipReason> = new Set<SkipReason>([
  'outside_hours',
  'no_group_members',
  'none_available',
  'all_at_capacity',
  'no_skill_match',
]);

export type AssignOptions = {
  /** Route into this group instead of the ticket's own. Also moves the ticket. */
  groupId?: string | null;
  /** Override the group's configured strategy for this one assignment. */
  strategy?: AssignmentStrategy;
  /** Names the rule or job that asked, for the timeline. */
  actorLabel?: string;
  now?: Date;
};

/**
 * Pick an agent for one ticket and record what happened.
 *
 * Safe to call on anything, at any time: a ticket that is already assigned, or
 * resolved, or on a channel nobody may answer, returns without a write.
 */
export async function assignConversation(
  conversationId: string,
  options: AssignOptions = {},
): Promise<AssignmentOutcome> {
  const now = options.now ?? new Date();

  const accountable = alias(agents, 'accountable');
  const rows = await db
    .select({
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      requesterEmail: contacts.primaryEmail,
      formSlug: ticketForms.slug,
      accountableActive: accountable.isActive,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(ticketForms, eq(ticketForms.id, conversations.formId))
    .leftJoin(accountable, eq(accountable.id, conversations.accountableAgentId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const ticket = rows[0];
  if (!ticket) return { assignedTo: null, reason: 'not_assignable' };

  const conversation = ticket.conversation;

  // A bot transcript is not work to hand out, and neither is a deleted, merged,
  // spam or finished ticket. Same population the dashboard calls the backlog.
  const assignable = !(
    conversation.deletedAt ||
    conversation.mergedIntoId ||
    conversation.isSpam ||
    isReadOnlyChannel(conversation.channel) ||
    !['open', 'pending'].includes(ticket.statusCategory)
  );

  if (conversation.assigneeAgentId) {
    // An owned ticket is assigned in the insert that creates it (`ownerStamp`),
    // so a rule routing it meets it already held — by the owner, whom this
    // call would have chosen anyway. The group the rule names still applies,
    // as it does in the owner branch below: without it, an owned ticket never
    // reaches the group whose SLA policy, hours and members the rule meant.
    // Anybody else holding a ticket was given it on purpose, and a rule has
    // never moved their ticket.
    if (
      assignable &&
      options.groupId &&
      options.groupId !== conversation.groupId &&
      conversation.assigneeAgentId === conversation.accountableAgentId
    ) {
      await moveToGroup(conversationId, options.groupId, options.actorLabel);
    }
    return { assignedTo: null, reason: 'already_assigned' };
  }

  if (!assignable) return { assignedTo: null, reason: 'not_assignable' };

  // The number's owner, ahead of everything the rota would ask — see the
  // module header for why none of it applies.
  if (conversation.accountableAgentId && ticket.accountableActive) {
    if (options.groupId && options.groupId !== conversation.groupId) {
      await moveToGroup(conversationId, options.groupId, options.actorLabel);
    }
    return handBackToOwner(
      conversationId,
      conversation.accountableAgentId,
      conversation.channelId,
      { actorLabel: options.actorLabel, now },
    );
  }

  const groupId = options.groupId ?? conversation.groupId;
  if (!groupId) return { assignedTo: null, reason: 'no_group' };

  const groupRow = (await db.select().from(groups).where(eq(groups.id, groupId)).limit(1))[0];
  if (!groupRow) return { assignedTo: null, reason: 'no_group' };

  /*
   * The group's settings, with the round-robin cursor deliberately removed.
   *
   * Everything else on this row is configuration an admin edits — the strategy,
   * the caps, whether skills are matched, whether hours gate it — and reading it
   * a moment before the lock is harmless: those change rarely, and a pick made
   * against a setting from two seconds ago is not wrong in any way a person can
   * see.
   *
   * `lastAssignedAgentId` is different in kind, because *this code path writes it
   * on every assignment*. Read before the lock, it is a value a concurrent
   * assignment may already have advanced while this call sat waiting — and using
   * it would hand two tickets to the same agent, which is the exact failure the
   * lock exists to prevent. It is read again from the locked row below.
   *
   * Destructured away rather than merely not-used, so reaching for it out here
   * is a compile error rather than a silent misroute nobody notices until the
   * rota looks lopsided.
   */
  const { lastAssignedAgentId: _preLockCursor, ...group } = groupRow;

  /*
   * A caller that named a group is routing the ticket there, and that half
   * happens whether or not anybody turns out to be free to take it.
   *
   * Doing it before the pick rather than alongside it is the difference between
   * a rule that reads "urgent shipping tickets go to the shipping team" and one
   * that reads "…unless everybody there is busy, in which case leave it where it
   * was". Out of hours, at capacity, no skill match — the ticket still belongs to
   * that team's queue, and that is where somebody will look for it.
   */
  if (options.groupId && options.groupId !== conversation.groupId) {
    await moveToGroup(conversationId, groupId, options.actorLabel);
  }

  const strategy = options.strategy ?? group.assignmentStrategy;
  if (strategy === 'manual') return { assignedTo: null, reason: 'strategy_manual' };

  if (group.assignWithinHoursOnly) {
    const catalog = await loadHoursCatalog();
    const hours = groupHours(catalog, groupId);
    // No schedule configured anywhere means nobody has said when this team
    // works, which is not the same as saying they never do. Assign.
    if (hours && !isWithinBusinessHours(hours, now)) {
      await recordSkip(conversationId, 'outside_hours', options.actorLabel);
      return { assignedTo: null, reason: 'outside_hours' };
    }
  }

  // Skills are resolved outside the transaction: they read only configuration
  // and the ticket, neither of which the lock protects.
  let requiredSkillIds: string[] = [];
  if (group.matchSkills && !skillTimeoutElapsed(group, conversation.createdAt, now)) {
    requiredSkillIds = matchingSkills(
      await activeSkills(),
      conversationFacts(
        {
          conversation,
          statusCategory: ticket.statusCategory,
          requesterEmail: ticket.requesterEmail,
        },
        now,
      ),
    );
  }

  const outcome = await db.transaction(async (tx) => {
    /*
     * Serialise this group's assignments against each other.
     *
     * Without the lock, two tickets arriving in the same second read the same
     * cursor and land on the same agent, and two load-balanced picks both see
     * the counts from before either of them wrote. The lock is on the group row
     * rather than on the tickets because the group is what they contend for —
     * the cursor and the roster's load. At this team's size the contention is a
     * few milliseconds and only ever between tickets that were going to the
     * same place anyway.
     */
    const lockedGroups = await tx
      .select({ lastAssignedAgentId: groups.lastAssignedAgentId })
      .from(groups)
      .where(eq(groups.id, groupId))
      .for('update');

    // Re-read the assignee inside the lock. Between the check above and here,
    // an agent may have picked the ticket up by hand.
    const current = await tx
      .select({ assigneeAgentId: conversations.assigneeAgentId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (current[0]?.assigneeAgentId) {
      return { assignedTo: null, reason: 'already_assigned' as SkipReason };
    }

    const roster = await loadRoster(tx, groupId);
    if (roster.length === 0) {
      return { assignedTo: null, reason: 'no_group_members' as SkipReason };
    }

    const { eligible, rejected } = filterCandidates(roster, {
      requiredSkillIds,
      groupDefaultMaxOpen: group.defaultMaxOpenTickets,
      now,
    });

    if (eligible.length === 0) {
      return { assignedTo: null, reason: skipReasonFor(rejected) };
    }

    // From the locked row, never from the copy loaded before the transaction —
    // see the note where that copy is destructured. `?? null` rather than an
    // assertion: the group can be deleted between the two reads.
    const cursor = lockedGroups[0]?.lastAssignedAgentId ?? null;
    const agentId =
      strategy === 'load_balanced'
        ? pickLoadBalanced(eligible, cursor)
        : pickRoundRobin(eligible, cursor);

    if (!agentId) return { assignedTo: null, reason: 'none_available' as SkipReason };

    await tx
      .update(conversations)
      .set({ assigneeAgentId: agentId, assignedAt: now })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.assigneeAgentId)));

    await tx.update(groups).set({ lastAssignedAgentId: agentId }).where(eq(groups.id, groupId));

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'assigned',
      // No actor agent: nobody clicked anything. The label is what makes "why is
      // this mine?" answerable — it names the mechanism, and the rule when a
      // rule asked.
      actorLabel: options.actorLabel ?? 'auto_assign',
      data: {
        to: agentId,
        strategy,
        ...(requiredSkillIds.length > 0 ? { skills: requiredSkillIds } : {}),
      },
    });

    return { assignedTo: agentId, reason: null };
  });

  if (!outcome.assignedTo && outcome.reason) {
    await recordSkip(conversationId, outcome.reason, options.actorLabel);
  }

  return outcome;
}

/**
 * Route the ticket into a group a caller named, and say so on the timeline.
 *
 * Shared by the rota and the owner's path, so a rule moving a ticket writes
 * the same event whoever then holds it. Conditional on the group existing,
 * because the owner's path reaches here without having looked the group up: a
 * rule naming a group deleted since would otherwise throw on the foreign key
 * and take the assignment down with it, where the rota answers `no_group`.
 */
async function moveToGroup(
  conversationId: string,
  groupId: string,
  actorLabel: string | undefined,
): Promise<void> {
  const moved = await db
    .update(conversations)
    .set({ groupId })
    .where(
      and(
        eq(conversations.id, conversationId),
        exists(db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId))),
      ),
    )
    .returning({ id: conversations.id });
  if (moved.length === 0) return;

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'group_changed',
    actorLabel: actorLabel ?? 'auto_assign',
    data: { to: groupId },
  });
}

/**
 * Give an unassigned owned ticket back to its number's owner.
 *
 * Guarded on `assignee_agent_id IS NULL` in the write itself, like every other
 * entry point here: an agent may have picked the ticket up since it was read,
 * and they keep it. No group lock, because no cursor or roster is read.
 */
async function handBackToOwner(
  conversationId: string,
  ownerId: string,
  channelId: string | null,
  { actorLabel, now }: { actorLabel: string | undefined; now: Date },
): Promise<AssignmentOutcome> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(conversations)
      .set({ assigneeAgentId: ownerId, assignedAt: now })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.assigneeAgentId)))
      .returning({ id: conversations.id });
    if (updated.length === 0) return { assignedTo: null, reason: 'already_assigned' as SkipReason };

    await recordOwnerAssigned(tx, {
      conversationId,
      ownerId,
      channelId,
      actorLabel: actorLabel ?? 'auto_assign',
    });
    return { assignedTo: ownerId, reason: null };
  });
}

/**
 * The group's roster, with everything the decision needs to reject somebody.
 *
 * This is the first query in this system to use `group_members` as a constraint
 * rather than to draw a list — membership has been decoration since the schema
 * was written.
 *
 * The open count is a correlated subquery rather than a join so that an agent
 * holding nothing still comes back with a zero: dropping out of the result set
 * and being full look identical to the caller otherwise, and only one of them
 * means "do not give this person work".
 */
async function loadRoster(tx: Pick<typeof db, 'select'>, groupId: string): Promise<CandidateRow[]> {
  const rows = await tx
    .select({
      agentId: agents.id,
      name: sql<string>`coalesce(nullif(${agents.name}, ''), ${agents.email})`,
      presence: agents.presence,
      lastSeenAt: agents.lastSeenAt,
      isAcceptingTickets: agents.isAcceptingTickets,
      maxOpenTickets: agents.maxOpenTickets,
      openTickets: sql<number>`(
        select count(*)::int
        from ${conversations}
        inner join ${ticketStatuses} on ${ticketStatuses.id} = ${conversations.statusId}
        where ${conversations.assigneeAgentId} = ${agents}.id
          and ${openBacklog()}
      )`,
      skillIds: sql<string[]>`coalesce((
        select array_agg(${agentSkills.skillId}::text)
        from ${agentSkills}
        where ${agentSkills.agentId} = ${agents}.id
      ), '{}')`,
    })
    .from(agents)
    .innerJoin(groupMembers, eq(groupMembers.agentId, agents.id))
    .where(and(eq(groupMembers.groupId, groupId), eq(agents.isActive, true)));

  return rows.map((row) => ({
    ...row,
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt) : null,
    skillIds: row.skillIds ?? [],
  }));
}

/**
 * The most useful of the reasons the roster was rejected for.
 *
 * Ordered by what an admin can do about it. Somebody being here but full is a
 * number in a form; nobody having the skill is a skills problem; nobody being
 * here at all is a rota problem. Reporting the most actionable one that actually
 * occurred beats reporting the most common.
 */
function skipReasonFor(rejected: Record<string, number>): SkipReason {
  if ((rejected.at_capacity ?? 0) > 0) return 'all_at_capacity';
  if ((rejected.missing_skill ?? 0) > 0) return 'no_skill_match';
  return 'none_available';
}

function skillTimeoutElapsed(
  group: { skillTimeoutMins: number | null },
  createdAt: Date,
  now: Date,
): boolean {
  if (group.skillTimeoutMins === null) return false;
  return now.getTime() - createdAt.getTime() >= group.skillTimeoutMins * 60_000;
}

/**
 * Write down why this ticket was not assigned — once per reason.
 *
 * The sweep re-attempts every unassigned ticket every five minutes. Without the
 * dedupe, a ticket that arrives on a Friday evening carries two hundred
 * identical "outside business hours" entries by Monday and the timeline stops
 * being readable. Re-recording when the reason *changes* is the useful part: a
 * ticket that was waiting for a skilled agent and is now waiting for a free one
 * has moved, and the timeline should say so.
 */
async function recordSkip(
  conversationId: string,
  reason: SkipReason,
  actorLabel: string | undefined,
): Promise<void> {
  if (!WORTH_RECORDING.has(reason)) return;

  const last = await db
    .select({ type: conversationEvents.type, data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        sql`${conversationEvents.type} in ('assigned', 'unassigned', 'assignment_skipped')`,
      ),
    )
    .orderBy(sql`${conversationEvents.createdAt} desc`)
    .limit(1);

  const previous = last[0];
  if (previous?.type === 'assignment_skipped') {
    const data = previous.data as { reason?: string } | null;
    if (data?.reason === reason) return;
  }

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'assignment_skipped',
    actorLabel: actorLabel ?? 'auto_assign',
    data: { reason },
  });
}
