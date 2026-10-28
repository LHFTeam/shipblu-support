import { and, eq, isNull, sql } from 'drizzle-orm';
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
import { logger } from '@/lib/log';
import { isWorkable } from '@/lib/routing/decide';
import { endHold } from '@/lib/routing/end-hold';
import { recordHeldAssignment } from '@/lib/routing/held-assignment';
import { isHeld } from '@/lib/routing/hold';
import { conversationFacts } from '@/lib/rules/facts';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { openBacklog } from '@/lib/tickets/backlog';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { moveToGroupIfElsewhere } from '@/lib/tickets/move-group';
import { lockedStatusCategory, statusCategoryOf } from '@/lib/tickets/status-category';
import { recordOwnerAssigned } from '@/lib/whatsapp/number-owner';
import { filterCandidates, type CandidateRow } from './eligibility';
import { pickLoadBalanced, pickRoundRobin } from './strategies';
import { activeSkills, matchingSkills } from './skills';

const log = logger('assignment');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 *
 * And one kind of ticket waits: one held for the router
 * (`plans/ticket-category-routing.md`, decision 5), whose group is not
 * settled yet. Assigning it in the group it arrived in and then taking it back
 * when it moved would break the first rule above, and show the ticket in one
 * agent's queue before it vanished; so every path answers `awaiting_route`
 * until the hold ends, and whatever ends it assigns it then — with the
 * strategy a rule asked for meanwhile, which the hold keeps
 * (`recordHeldAssignment`).
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
  | 'no_skill_match'
  /**
   * Held for the router (`lib/routing/hold.ts`): the ticket's group is not
   * settled yet, and whatever ends the hold assigns it then. Never recorded —
   * a timeline entry per skip once produced 1,432 rows for 137 tickets.
   */
  | 'awaiting_route'
  /** The ticket left the group between the read and the lock. Whoever moved it assigns it. */
  | 'moved';

export type AssignmentOutcome = Picked & {
  /**
   * Whether this call moved the ticket into the group the caller named — the
   * routing half, which stands whether or not anybody was then picked. A
   * caller owes the SLA policy a second look only when the group really
   * changed: comparing the rule's group with the ticket it started from also
   * counts a ticket the rota left where it was (a holder who is not the
   * number's owner, a group deleted since). The automation engine reads the
   * same answer through `routed`, which survives a throw after the move.
   */
  movedGroup: boolean;
};

/** Who the pick chose, or why it chose nobody. */
type Picked = {
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
  /**
   * Told of the move the moment it commits, for a caller that owes a follow-up
   * for it even when the call then throws — the automation engine, whose
   * `finally` re-times the clocks. The move commits before the pick runs, so a
   * pick that fails afterwards takes `movedGroup` down with it and leaves the
   * ticket in the new group on the old one's policy and hours. A fresh
   * `{ moved: false }`; `movedGroup` reads the same answer once the call returns.
   * `endedHold` is set beside it when the move ended a routing hold
   * (`endsHoldAs`), which owes the held reply once the caller is done.
   */
  routed?: { moved: boolean; endedHold?: boolean };
  /**
   * Ends a routing hold (`endHold`), as this outcome, in the transaction that
   * moves the ticket into `groupId` — and only when it does move it. A rule's
   * `auto_assign` naming another group has decided where the ticket goes;
   * one naming the group it is in has decided nothing, and stays held.
   */
  endsHoldAs?: 'rule' | 'manual';
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
  const routed = options.routed ?? { moved: false };
  const picked = await routeAndPick(conversationId, options, routed);
  return { ...picked, movedGroup: routed.moved };
}

/**
 * The body of `assignConversation`, which every return below answers through:
 * `routed` is how the group move, made once before the branches, reaches the
 * outcome without each of a dozen returns repeating it.
 */
async function routeAndPick(
  conversationId: string,
  options: AssignOptions,
  routed: { moved: boolean; endedHold?: boolean },
): Promise<Picked> {
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

  const assignable = isWorkToHandOut({ ...conversation, statusCategory: ticket.statusCategory });

  /*
   * The group a caller is routing the ticket to, decided once for every branch
   * below: a caller that named a group is routing the ticket there, and that
   * half happens whether or not anybody turns out to be free to take it — or
   * whether the ticket's number's owner takes it instead.
   *
   * Doing it before the pick rather than alongside it is the difference between
   * a rule that reads "urgent shipping tickets go to the shipping team" and one
   * that reads "…unless everybody there is busy, in which case leave it where it
   * was". Out of hours, at capacity, no skill match — the ticket still belongs to
   * that team's queue, and that is where somebody will look for it.
   */
  const routeTo =
    options.groupId && options.groupId !== conversation.groupId ? options.groupId : null;

  /*
   * The move, made once and here, so the one write is the one answer
   * (`movedGroup`) whichever branch below then picks. It applies to work to
   * hand out, unassigned or held by its number's owner. An owned ticket is
   * assigned in the insert that creates it (`ownerStamp`), so a rule routing it
   * meets it held by the owner, whom this call would have chosen anyway, and
   * without the move it never reaches the group whose SLA policy, hours and
   * members the rule meant. Anybody else holding a ticket was given it on
   * purpose, and a rule has never moved their ticket.
   */
  const holder = conversation.assigneeAgentId;
  let endedHold = false;
  if (routeTo && assignable && (!holder || holder === conversation.accountableAgentId)) {
    endedHold = await moveToGroup(conversationId, routeTo, options, routed);
  }

  if (conversation.assigneeAgentId) return { assignedTo: null, reason: 'already_assigned' };

  if (!assignable) return { assignedTo: null, reason: 'not_assignable' };

  /*
   * Held for the router, ahead of the owner and the rota both: the hold is
   * absolute, and whatever ends it assigns the ticket then (`afterHoldEnded`).
   * Read off the snapshot, because a hold is born in the ticket's insert and
   * afterwards only ends: a stale "held" costs a skip that whoever ended it
   * makes good, and a stale "not held" cannot exist. Checked again under the
   * lock below all the same. A move this call made for a rule has ended it.
   */
  if (!endedHold && isHeld(conversation, now)) {
    await keepForHold(conversationId, options);
    return { assignedTo: null, reason: 'awaiting_route' };
  }

  // The number's owner, ahead of everything the rota would ask — see the
  // module header for why none of it applies.
  if (conversation.accountableAgentId && ticket.accountableActive) {
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
     * The ticket's row first, then the group's: the order the router, the
     * console and every other writer that moves a ticket take them in, so an
     * assignment never waits on a move that waits on it. And the re-read under
     * it is the answer, not a guess: a ticket moved out of this group, picked
     * up by hand, put on hold, resolved, merged, deleted or marked spam since
     * the snapshot cannot be assigned here. Without the last four, an agent's
     * resolve landing while the pick read its roster left the ticket resolved
     * in somebody's name, the cursor moved past them for work they never got,
     * and an `assigned` line after the resolve on the timeline. No join under
     * the lock — under READ COMMITTED a locked read that waited re-checks the
     * joined rows and can answer no row at all — so the status is a subquery
     * (`statusCategoryOf`), the same rule `lib/tickets/status-category.ts`
     * gives every locked read.
     *
     * NO KEY UPDATE, as every lock on a ticket's row is (`endHold` says why in
     * full): it waits on every other writer of the row just the same, where
     * FOR UPDATE would also stop every message inserted on the ticket — whose
     * foreign key takes KEY SHARE — until the pick below had committed.
     */
    const [current] = await tx
      .select({
        assigneeAgentId: conversations.assigneeAgentId,
        groupId: conversations.groupId,
        routingWindowEndsAt: conversations.routingWindowEndsAt,
        routingDecidedAt: conversations.routingDecidedAt,
        channel: conversations.channel,
        statusId: conversations.statusId,
        statusCategory: statusCategoryOf(),
        deletedAt: conversations.deletedAt,
        isSpam: conversations.isSpam,
        mergedIntoId: conversations.mergedIntoId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('no key update');
    if (!current) return { assignedTo: null, reason: 'not_assignable' as SkipReason };
    // An agent may have picked the ticket up by hand since the check above.
    if (current.assigneeAgentId) {
      return { assignedTo: null, reason: 'already_assigned' as SkipReason };
    }
    const statusCategory = await lockedStatusCategory(tx, current);
    if (!isWorkToHandOut({ ...current, statusCategory })) {
      return { assignedTo: null, reason: 'not_assignable' as SkipReason };
    }
    if (current.groupId !== groupId) return { assignedTo: null, reason: 'moved' as SkipReason };
    if (isHeld(current, now)) return { assignedTo: null, reason: 'awaiting_route' as SkipReason };

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

    // Still guarded, the module's one invariant, though the row is locked; and
    // checked, so a write that matched nothing advances no cursor and records
    // no assignment that did not happen.
    const taken = await tx
      .update(conversations)
      .set({ assigneeAgentId: agentId, assignedAt: now })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.assigneeAgentId)))
      .returning({ id: conversations.id });
    if (taken.length === 0) return { assignedTo: null, reason: 'already_assigned' as SkipReason };

    await tx.update(groups).set({ lastAssignedAgentId: agentId }).where(eq(groups.id, groupId));

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'assigned',
      // No actor agent: nobody clicked anything. The label is what makes "why is
      // this mine?" answerable — it names the mechanism, and the rule when a
      // rule asked.
      actorLabel: options.actorLabel ?? 'auto_assign',
      // Stamped under the lock this transaction may have waited for, never at
      // its start: an edit committed while the pick waited would otherwise
      // sort after the assignment that followed it (`CHANGE_STAMP`).
      createdAt: CHANGE_STAMP,
      data: {
        to: agentId,
        strategy,
        ...(requiredSkillIds.length > 0 ? { skills: requiredSkillIds } : {}),
      },
    });

    return { assignedTo: agentId, reason: null };
  });

  if (outcome.reason === 'awaiting_route') await keepForHold(conversationId, options);
  if (!outcome.assignedTo && outcome.reason) {
    await recordSkip(conversationId, outcome.reason, options.actorLabel);
  }

  return outcome;
}

/**
 * Whether a ticket is work to hand out at all. A bot transcript is not, and
 * neither is a deleted, merged, spam or finished ticket — the population the
 * dashboard calls the backlog. Asked of the snapshot before anything is
 * written, and again of the row under the pick's lock, so the two cannot come
 * to disagree about what qualifies.
 *
 * All but the bot is the router's `isWorkable`, not a copy of it, so this,
 * the router's `not_open`, the inbox's "Routing…" (`routingHold`) and the Hand
 * to offer (`handToTarget`, which adds the same read-only check) read one rule
 * of what work is, and a status category added later changes all four at
 * once. The bot is this module's own question: the router never meets a bot
 * ticket, since `routingModeOf` never routes one.
 */
function isWorkToHandOut(ticket: Parameters<typeof isWorkable>[0] & { channel: string }): boolean {
  return isWorkable(ticket) && !isReadOnlyChannel(ticket.channel);
}

/**
 * A strategy the caller asked for, kept for the end of the hold that made it
 * wait: an `auto_assign` rule's, the only caller that names one. Without it
 * the hold's end picks with the group's own, and a round-robin rule over a
 * group left on `manual` assigns nobody (`recordHeldAssignment`).
 *
 * After the transaction, never in it, and best-effort: the skip is the
 * answer either way, and a failure here costs the rule its strategy, not the
 * caller its pass.
 */
async function keepForHold(
  conversationId: string,
  { strategy, actorLabel }: Pick<AssignOptions, 'strategy' | 'actorLabel'>,
): Promise<void> {
  if (!strategy) return;
  try {
    await recordHeldAssignment(conversationId, strategy, actorLabel ?? 'auto_assign');
  } catch (error) {
    log.error(`could not keep the held strategy on ${conversationId}`, error);
  }
}

/**
 * Route the ticket into a group a caller named, and say so on the timeline.
 *
 * Shared by the rota and the owner's path, so a rule moving a ticket writes
 * the same event whoever then holds it. Conditional on the group existing,
 * because the owner's path reaches here without having looked the group up: a
 * rule naming a group deleted since would otherwise throw on the foreign key
 * and take the assignment down with it, where the rota answers `no_group`.
 *
 * And conditional on the ticket being somewhere else, which is what the answer
 * reports (`movedGroup`). The caller decided to move it from a read taken
 * without a lock, so an agent moving it to the same group in between left an
 * update that matched the row anyway, and the rule recorded a move the agent
 * had made — and owed the SLA policy a second look for it. Both conditions are
 * `moveToGroupIfElsewhere`'s, the one definition of a move.
 */
async function moveToGroup(
  conversationId: string,
  groupId: string,
  { actorLabel, endsHoldAs }: Pick<AssignOptions, 'actorLabel' | 'endsHoldAs'>,
  routed: { moved: boolean; endedHold?: boolean },
): Promise<boolean> {
  const label = actorLabel ?? 'auto_assign';
  // The hold ends in the move's own transaction, so neither commits without
  // the other: stamped first, the sweep could assign the ticket in the group it
  // is about to leave; stamped after, a crash between would leave it in the
  // rule's group still held, for the router to move away from the rule.
  const result = await db.transaction(async (tx) => {
    if (
      !(await moveToGroupIfElsewhere(conversationId, groupId, {
        executor: tx,
        groupMustExist: true,
      }))
    ) {
      return { moved: false, endedHold: false };
    }
    // In the move's transaction and ahead of the hold's end, so the timeline
    // reads the move before the `routed` line naming it, as the console's
    // group case writes them: `endHold` stamps its line when it is written
    // (`CHANGE_STAMP`), and this one, inserted after the commit as it was,
    // sorted after the decision it was the reason for.
    await recordGroupChanged(tx, conversationId, groupId, label);
    const endedHold = endsHoldAs ? await endHold(tx, conversationId, endsHoldAs, { label }) : false;
    return { moved: true, endedHold };
  });
  if (!result.moved) return false;

  routed.moved = true;
  if (result.endedHold) routed.endedHold = true;
  return result.endedHold;
}

/**
 * The `group_changed` line for a move this call made, in the move's
 * transaction and ahead of the hold's end, logged when refused
 * (`recordLineIn`). The engine's `assign_group` writes its line the same way
 * (`recordIn`).
 */
async function recordGroupChanged(
  tx: Tx,
  conversationId: string,
  groupId: string,
  actorLabel: string,
): Promise<void> {
  const refused = await recordLineIn(tx, {
    conversationId,
    type: 'group_changed',
    actorLabel,
    data: { to: groupId },
  });
  if (refused) {
    log.error(`could not record the move of ${conversationId} to group ${groupId}`, refused);
  }
}

/**
 * A timeline line written inside the transaction of the write it records — a
 * rule's move or assignment, or this module's move for one — in a savepoint of
 * its own (`tx.transaction`). Answers the refusal, for the caller to log in its
 * own words, or null once the line is written.
 *
 * In the write's transaction, ahead of `endHold`, so the timeline reads the
 * write before the `routed` line it caused; and stamped once the write holds
 * the ticket's lock (`CHANGE_STAMP`), never at the transaction's start, which
 * after a wait on that lock sorts the line before an event committed while it
 * waited.
 *
 * In a savepoint because the line records the write and is not the write:
 * refused by Postgres — a trigger, a constraint — it is rolled back to and
 * answered, and the write, the hold's end and the follow-up they owe all
 * stand, as they did while the line was written after the commit. Only a
 * refusal. A statement that got no answer — the admission gate giving it up as
 * lost, or a cancel, either way `57014` — is thrown on, so the body fails and
 * its transaction rolls back, which is what `db/client.ts` relies on once it
 * has told the caller the transaction failed: swallowed here, the body went on
 * queueing `endHold` behind the stuck statement, and a connection that
 * answered after all committed a move and a hold's end the caller had been
 * told had failed, with nothing owed for either ever run.
 */
export async function recordLineIn(
  tx: Tx,
  line: Omit<typeof conversationEvents.$inferInsert, 'createdAt'>,
): Promise<unknown> {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.insert(conversationEvents).values({ ...line, createdAt: CHANGE_STAMP });
    });
    return null;
  } catch (error) {
    if (refusedByPostgres(error)) return error;
    throw error;
  }
}

/** `query_canceled`: a statement cancelled, or given up on by the admission gate. */
const QUERY_CANCELED = '57014';

/**
 * Whether Postgres itself answered a statement with an error, other than a
 * cancel: postgres.js's `PostgresError`, which drizzle hands on as the `cause`
 * of its own error for a statement it issued, and postgres.js throws bare for
 * the savepoint statements it writes itself. Known by its name, because
 * postgres.js is loaded as a value by `db/client.ts` alone
 * (`pool-confinement`); the name is the class's own, and survives because
 * neither the worker (`tsx`) nor Next (`serverExternalPackages`) bundles the
 * package. The admission gate's own errors are plain ones carrying `57014`,
 * and Postgres's answer to a cancel is a `PostgresError` carrying it too.
 */
function refusedByPostgres(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return [error, cause].some(
    (candidate) =>
      candidate instanceof Error &&
      candidate.name === 'PostgresError' &&
      (candidate as Error & { code?: unknown }).code !== QUERY_CANCELED,
  );
}

/**
 * Give an unassigned owned ticket back to its number's owner.
 *
 * The ticket's row is locked and read again first, as the rota's pick reads it
 * (`routeAndPick`), and for the same reason: the owner was chosen off a
 * snapshot, and an agent resolving the ticket, a merge, a delete or a spam
 * mark landing since left a finished ticket handed to the owner, with an
 * `assigned` line after the resolve — the guarded write alone asks only
 * whether somebody holds it. So is the owner it was chosen for: a handover
 * since makes the ticket somebody else's to answer for, and deactivating the
 * owner makes the number a team number (`effectiveOwnerId`). Either way this
 * answers `not_assignable`, and the next pass reads the ticket as it now is.
 * No join under the lock, so the status and the owner's activity are
 * subqueries (`statusCategoryOf`, `lib/tickets/status-category.ts`); NO KEY
 * UPDATE, as every lock on a ticket's row is.
 *
 * Still guarded on `assignee_agent_id IS NULL` in the write itself, like every
 * other entry point here: an agent who picked the ticket up keeps it. No group
 * lock, because no cursor or roster is read.
 */
async function handBackToOwner(
  conversationId: string,
  ownerId: string,
  channelId: string | null,
  { actorLabel, now }: { actorLabel: string | undefined; now: Date },
): Promise<Picked> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        assigneeAgentId: conversations.assigneeAgentId,
        accountableAgentId: conversations.accountableAgentId,
        accountableActive: sql<
          boolean | null
        >`(select ${agents.isActive} from ${agents} where ${agents.id} = ${conversations.accountableAgentId})`,
        channel: conversations.channel,
        statusId: conversations.statusId,
        statusCategory: statusCategoryOf(),
        deletedAt: conversations.deletedAt,
        isSpam: conversations.isSpam,
        mergedIntoId: conversations.mergedIntoId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('no key update');
    if (!current) return { assignedTo: null, reason: 'not_assignable' as SkipReason };
    if (current.assigneeAgentId) {
      return { assignedTo: null, reason: 'already_assigned' as SkipReason };
    }
    const statusCategory = await lockedStatusCategory(tx, current);
    if (!isWorkToHandOut({ ...current, statusCategory })) {
      return { assignedTo: null, reason: 'not_assignable' as SkipReason };
    }
    if (current.accountableAgentId !== ownerId || current.accountableActive !== true) {
      return { assignedTo: null, reason: 'not_assignable' as SkipReason };
    }

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
