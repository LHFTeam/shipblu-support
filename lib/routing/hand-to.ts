import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  channels,
  conversationEvents,
  conversations,
  groups,
  ticketCategories,
} from '@/db/schema';
import { assignConversation, type SkipReason } from '@/lib/assignment';
import { runAutomations } from '@/lib/automations';
import { afterRoutingChanged } from '@/lib/sla';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { moveToGroupIfElsewhere } from '@/lib/tickets/move-group';
import { lockedStatusCategory, statusCategoryOf } from '@/lib/tickets/status-category';
import type { StatusCategory } from '@/lib/tickets/vocabulary';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import { afterHoldEnded } from './after-hold';
import { endHold } from './end-hold';
import { isHeld, type HoldColumns } from './hold';

/**
 * "Hand to <group>": after the hold, a category edit only relabels the ticket,
 * and this is the one action that then moves it to the category's route group,
 * clears whoever holds it and assigns it in the new group
 * (`plans/ticket-category-routing.md`, decision 5).
 *
 * The clearing is the point. The console's group case and `assign_group` both
 * leave the assignee where it is, so moving a misrouted ticket by hand leaves
 * a Sales agent holding a Merchant Care ticket — the cross-team holder routing
 * exists to avoid — and it is how a supervisor undoes a wrong route in one
 * click (the plan's risk register).
 *
 * Two halves. `handToTarget` is pure and decides whether it is offered, and
 * where to: the ticket page asks it of what it has already loaded, and
 * `handToRouteGroup` asks it again of the row it has locked, so the button and
 * the write cannot disagree about which tickets qualify. The page imports this
 * module whole; a client component may only name its types.
 */

export type HandToTicket = HoldColumns & {
  statusCategory: StatusCategory;
  channel: string;
  groupId: string | null;
  categoryId: string | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  deletedAt: Date | null;
  /**
   * Whether an active owner of the ticket's WhatsApp number answers for it —
   * its `accountable_agent_id`, while that agent is active.
   */
  ownerAnswers: boolean;
  /** Whether the ticket is on a coexistence number, answered from the phone. */
  coexistence: boolean;
};

/** Why a ticket is not offered the hand-over. */
export type HandToRefusal =
  | 'not_permitted'
  | 'not_open'
  | 'held'
  | 'owned_number'
  | 'coexistence'
  | 'no_route'
  | 'already_there';

export type HandTo =
  { offered: true; groupId: string; groupName: string } | { offered: false; reason: HandToRefusal };

/** The offer itself, as the ticket page hands it to the sidebar. */
export type HandToTarget = Extract<HandTo, { offered: true }>;

/**
 * Whether a ticket is offered "Hand to <group>", and which group.
 *
 * Read off the ticket's state rather than off "a category edit just
 * happened": an agent who changed the category, went to ask somebody and came
 * back is still owed the button, and the risk it answers — a confident wrong
 * route — is undone long after the edit that exposed it. So it is offered
 * whenever all of these hold, in this order, the first that does not naming
 * the refusal:
 *
 * - the agent may reassign tickets (`ticket.assign`) — the action clears an
 *   assignee and picks another;
 * - the ticket is work: open or pending, not spam, merged or deleted, and not
 *   on a read-only channel, none of which `assignConversation` would assign;
 * - it is not held. During the hold a category edit routes the ticket itself
 *   (`routeNow`), and a hand-over then would end the route as `manual` with
 *   the answer about to arrive;
 * - no active owner of its WhatsApp number answers for it. The owner is
 *   outside the rota, so `assignConversation` would hand the cleared ticket
 *   straight back to them: the hand-over would move the group and give the
 *   ticket back to its owner, which is not what the button says. The Group
 *   field still moves such a ticket;
 * - it is not on a coexistence number. Its replies are typed on the phone, so
 *   giving it to somebody in another group changes nothing about who answers
 *   it — the reason `routingModeOf` never routes one;
 * - its category has a route group, and the ticket is somewhere else.
 *
 * A retired category still routes, as `decide` routes on one: the ticket
 * still carries it, and the route group is the admin's answer for it. A route
 * group missing from `groups` is treated as none, which can only be a group
 * deleted since the page loaded (the foreign key is `set null`).
 */
export function handToTarget(
  ticket: HandToTicket,
  routes: {
    categories: readonly { id: string; routeGroupId: string | null }[];
    groups: readonly { id: string; name: string }[];
  },
  { canAssign, now }: { canAssign: boolean; now: Date },
): HandTo {
  const refuse = (reason: HandToRefusal): HandTo => ({ offered: false, reason });

  if (!canAssign) return refuse('not_permitted');
  if (
    ticket.deletedAt ||
    ticket.isSpam ||
    ticket.mergedIntoId ||
    isReadOnlyChannel(ticket.channel) ||
    !(ticket.statusCategory === 'open' || ticket.statusCategory === 'pending')
  ) {
    return refuse('not_open');
  }
  if (isHeld(ticket, now)) return refuse('held');
  if (ticket.ownerAnswers) return refuse('owned_number');
  if (ticket.coexistence) return refuse('coexistence');

  const category = ticket.categoryId
    ? routes.categories.find((row) => row.id === ticket.categoryId)
    : undefined;
  const group = category?.routeGroupId
    ? routes.groups.find((row) => row.id === category.routeGroupId)
    : undefined;
  if (!group) return refuse('no_route');
  if (group.id === ticket.groupId) return refuse('already_there');

  return { offered: true, groupId: group.id, groupName: group.name };
}

export type HandToResult =
  | {
      ok: false;
      /**
       * `changed`: the category routes somewhere other than the button said.
       * `reassigned`: somebody other than the assignee the page showed holds
       * the ticket now.
       */
      reason: HandToRefusal | 'not_found' | 'changed' | 'reassigned';
    }
  | {
      ok: true;
      groupName: string;
      /** Who the new group's rota picked, or null with the reason it picked nobody. */
      assignedTo: string | null;
      skipped: SkipReason | null;
      /**
       * Whose queue the ticket waits in when nobody could be given it: the
       * route group, or — `movedOn` — the group an `on_update` rule moved it
       * on to before the rota ran, which the rota then answered for. Null when
       * somebody was given it, and whenever the rota's answer was not that
       * nobody there could take it: a rule resolved the ticket
       * (`not_assignable`), somebody moved it meanwhile (`moved`), it is in no
       * group (`no_group`). Saying it waits in the route group's queue then
       * would be false, and the page re-drawn with the answer shows where it
       * went.
       */
      waitsIn: { groupName: string; movedOn: boolean } | null;
    };

/**
 * The rota's answers that leave the ticket in its group's queue for somebody
 * there to take: the reasons `assignment_skipped` records, and a manual group,
 * which never assigns.
 */
const WAITING: ReadonlySet<SkipReason> = new Set<SkipReason>([
  'strategy_manual',
  'outside_hours',
  'no_group_members',
  'none_available',
  'all_at_capacity',
  'no_skill_match',
]);

/**
 * The hand-over, server-side: nothing about where the ticket goes is taken
 * from the request. The target is the route group of the category the ticket
 * carries, read under the ticket's row lock, and the whole of `handToTarget`
 * is asked again of the locked row — a page drawn a minute ago is not the
 * authority on whether the ticket is still open, still unheld, or still filed
 * where it was. `expectedGroupId`, the group the button named, is only
 * compared: a category changed since the page loaded is refused rather than
 * handed to a group the agent never saw named. `expectedAssigneeId`, the
 * assignee the page drew the button from (null for nobody), is compared the
 * same way, because it is what decided whether the button asked twice: a
 * page drawn before a colleague took the ticket offers one click, and that
 * click must not take it off somebody the agent was never shown. Omitted, it
 * is not compared.
 *
 * In one transaction, the ticket's row first as every routing writer takes
 * it: the move (`moveToGroupIfElsewhere`, so a ticket already there writes
 * nothing), `group_changed`, the assignee cleared with `unassigned` when there
 * was one, and `endHold` as `manual` — a no-op on a ticket that never routed
 * or has been decided, which is every ticket `handToTarget` offers but the one
 * whose hold lapsed on a stuck job, and that one the agent has now decided.
 * The two events are stamped as they are written (`CHANGE_STAMP`), because
 * both are in one transaction and `now()` would tie them.
 *
 * After it commits, the follow-ups in the order the console's group case
 * takes them, which is not the router's (rules, then the SLA, then the
 * assignment and the reply). First the SLA policy chosen again for the move
 * (`afterRoutingChanged`): the move is this action's, and the rules' pass
 * re-times only what its own rules change, so nothing after would. Then the
 * `on_update` rules — the observer pass every console edit owes, run before
 * anybody is assigned so that a rule moving the ticket on hands it to the
 * group it ends in rather than leaving the new group's agent holding it. Then
 * the assignment, whose `assigned` event is the third line the plan asks for.
 * Last, a hold this ended owes its out-of-hours reply (`afterHoldEnded`, whose
 * assignment is then a no-op), told the hours of the group the rules left the
 * ticket in.
 */
export async function handToRouteGroup(
  conversationId: string,
  actor: { agentId: string },
  {
    expectedGroupId,
    expectedAssigneeId,
    now = new Date(),
  }: { expectedGroupId?: string | null; expectedAssigneeId?: string | null; now?: Date } = {},
): Promise<HandToResult> {
  const write = await db.transaction(async (tx) => {
    // No join under the lock: a locked read that waited re-checks joined rows
    // against the newest version and can answer no row at all
    // (`lib/tickets/status-category.ts`). Everything else is read after it.
    //
    // `no key update`, the lock the UPDATEs below take anyway, rather than
    // `update`. It still conflicts with every other routing writer's lock and
    // with any UPDATE of the row, which is what serialises them; what it
    // leaves alone is the key-share lock a message or an event inserted for
    // the ticket takes through its foreign key, so a customer's message
    // arriving mid-hand-over lands without waiting for it. `endHold`, called
    // below, takes the same lock for a sharper reason: there, after the
    // caller's write, `update` upgraded past an inserted message's key-share
    // lock and deadlocked against the ingest that then updates the ticket.
    const [ticket] = await tx
      .select({
        channel: conversations.channel,
        channelId: conversations.channelId,
        groupId: conversations.groupId,
        categoryId: conversations.categoryId,
        assigneeAgentId: conversations.assigneeAgentId,
        accountableAgentId: conversations.accountableAgentId,
        statusId: conversations.statusId,
        statusCategory: statusCategoryOf(),
        isSpam: conversations.isSpam,
        mergedIntoId: conversations.mergedIntoId,
        deletedAt: conversations.deletedAt,
        routingWindowEndsAt: conversations.routingWindowEndsAt,
        routingDecidedAt: conversations.routingDecidedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('no key update');
    if (!ticket) return { ok: false as const, reason: 'not_found' as const };

    const statusCategory = await lockedStatusCategory(tx, ticket);
    const [category] = ticket.categoryId
      ? await tx
          .select({ id: ticketCategories.id, routeGroupId: ticketCategories.routeGroupId })
          .from(ticketCategories)
          .where(eq(ticketCategories.id, ticket.categoryId))
      : [];
    const [group] = category?.routeGroupId
      ? await tx
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(eq(groups.id, category.routeGroupId))
      : [];
    const [channel] = ticket.channelId
      ? await tx
          .select({ type: channels.type, config: channels.config })
          .from(channels)
          .where(eq(channels.id, ticket.channelId))
      : [];
    const [accountable] = ticket.accountableAgentId
      ? await tx
          .select({ isActive: agents.isActive })
          .from(agents)
          .where(eq(agents.id, ticket.accountableAgentId))
      : [];

    const decision = handToTarget(
      {
        ...ticket,
        statusCategory,
        ownerAnswers: accountable?.isActive === true,
        coexistence: channel?.type === 'whatsapp' && parseCoexistence(channel.config) !== null,
      },
      { categories: category ? [category] : [], groups: group ? [group] : [] },
      { canAssign: true, now },
    );
    if (!decision.offered) return { ok: false as const, reason: decision.reason };
    if (expectedGroupId && expectedGroupId !== decision.groupId) {
      return { ok: false as const, reason: 'changed' as const };
    }
    if (expectedAssigneeId !== undefined && expectedAssigneeId !== ticket.assigneeAgentId) {
      return { ok: false as const, reason: 'reassigned' as const };
    }

    const moved = await moveToGroupIfElsewhere(conversationId, decision.groupId, {
      executor: tx,
      groupMustExist: true,
    });
    // Unreachable after `already_there`, under the lock; kept as the writer's
    // own answer, which is the one definition of a move.
    if (!moved) return { ok: false as const, reason: 'already_there' as const };

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'group_changed',
      actorAgentId: actor.agentId,
      createdAt: CHANGE_STAMP,
      data: { to: decision.groupId, from: ticket.groupId },
    });

    if (ticket.assigneeAgentId) {
      await tx
        .update(conversations)
        .set({ assigneeAgentId: null, assignedAt: null })
        .where(eq(conversations.id, conversationId));
      // `from`, which the agent rollup reads to count the ticket as handed on
      // from its holder (`transferred_away_count`).
      await tx.insert(conversationEvents).values({
        conversationId,
        type: 'unassigned',
        actorAgentId: actor.agentId,
        createdAt: CHANGE_STAMP,
        data: { to: null, from: ticket.assigneeAgentId },
      });
    }

    const endedHold = await endHold(tx, conversationId, 'manual', { agentId: actor.agentId }, now);
    return {
      ok: true as const,
      groupId: decision.groupId,
      groupName: decision.groupName,
      moved,
      endedHold,
    };
  });
  if (!write.ok) return write;

  await afterRoutingChanged(conversationId, { category: false, group: write.moved });
  await runAutomations('on_update', conversationId);
  const outcome = await assignConversation(conversationId, { actorLabel: 'auto_assign' });
  if (write.endedHold) await afterHoldEnded(conversationId);

  return {
    ok: true,
    groupName: write.groupName,
    assignedTo: outcome.assignedTo,
    skipped: outcome.reason,
    waitsIn:
      !outcome.assignedTo && outcome.reason && WAITING.has(outcome.reason)
        ? await queueOf(conversationId, write.groupId)
        : null,
  };
}

/**
 * The group the ticket is in now, by name, and whether that is somewhere other
 * than the group it was handed to. Read after the follow-ups and without a
 * lock: the rota has answered for whatever group the rules left the ticket
 * in, and this only names it.
 */
async function queueOf(
  conversationId: string,
  handedTo: string,
): Promise<{ groupName: string; movedOn: boolean } | null> {
  const [current] = await db
    .select({ groupId: conversations.groupId, groupName: groups.name })
    .from(conversations)
    .leftJoin(groups, eq(groups.id, conversations.groupId))
    .where(eq(conversations.id, conversationId));
  if (!current?.groupId || !current.groupName) return null;
  return { groupName: current.groupName, movedOn: current.groupId !== handedTo };
}
