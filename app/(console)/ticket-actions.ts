'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, conversationEvents, conversations, groups, ticketStatuses } from '@/db/schema';
import { purgeConversation, type PurgeRefusal } from '@/lib/admin/purge';
import { hiddenScopeRefusal } from '@/lib/admin/purge-visibility';
import { requireAgent } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { uuidField } from '@/lib/http/form-data';
import { isUuid } from '@/lib/http/uuid';
import { can } from '@/lib/auth/permissions';
import { isPriority } from '@/lib/tickets/vocabulary';
import { CATEGORY_REFUSALS, setConversationCategory } from '@/lib/categories/write';
import { afterRoutingChanged, onPriorityChanged } from '@/lib/sla';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { moveToGroupIfElsewhere } from '@/lib/tickets/move-group';
import { routeNow } from '@/lib/routing/apply';
import { afterHoldEnded } from '@/lib/routing/after-hold';
import { endHold } from '@/lib/routing/end-hold';
import { handToRouteGroup, type HandToResult } from '@/lib/routing/hand-to';
import { undecidedRouting } from '@/lib/routing/state';
import { isBlank } from '@/lib/tickets/custom-fields';
import { parseFieldValue } from '@/lib/tickets/custom-fields-parse';
import { getTicketField } from '@/lib/tickets/lookups';
import {
  loadConversation,
  refresh,
  refuseIfIncomplete,
  refuseIfNoRootCause,
} from '@/lib/tickets/console-guards';
import { changeStatus } from '@/lib/tickets/status';
import { seesTicket } from '@/lib/tickets/visibility';
import { scheduleSurvey, setSurveySuppressed } from '@/lib/csat';
import type { ActionState } from './action-state';

// --- Ticket properties ------------------------------------------------------

export async function updateTicket(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();

  const conversationId = String(formData.get('conversationId') ?? '');
  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const field = String(formData.get('field') ?? '');
  const value = String(formData.get('value') ?? '');

  // Set by the category case when the edit routed a held ticket, whose router
  // runs the update pass itself.
  let routedByCategory = false;
  // Set when the edit ended a routing hold, whose assignment and held reply
  // are owed once the observer rules below have run (`afterHoldEnded`).
  let endedHold = false;
  switch (field) {
    case 'status': {
      if (!isUuid(value)) return { error: 'Unknown status' };
      const statuses = await db
        .select({
          id: ticketStatuses.id,
          name: ticketStatuses.name,
          category: ticketStatuses.category,
          stopsSlaClock: ticketStatuses.stopsSlaClock,
        })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.id, value))
        .limit(1);

      const status = statuses[0];
      if (!status) return { error: 'Unknown status' };

      // Checked here rather than only by hiding the option, because the option
      // arrives back as a FormData string and the picker is not the authority
      // on what an agent may send.
      if (status.category === 'closed' && !can(agent, 'ticket.close')) {
        return { error: 'Only a supervisor can close a ticket — resolve it instead' };
      }

      // Both terminal categories, not just `resolved`. `Closed` is a seeded
      // status an agent can pick from the same dropdown, and gating only the
      // one next to it made the whole rule advisory: picking the other option
      // ended the ticket with no cause recorded and nothing to say so. See
      // `conversations.root_cause_set_at` for how a closed ticket's cause is
      // then dated: one closed without being resolved has no `resolved_at`
      // (closing a resolved one keeps the resolve it follows: `resolveStamp`).
      if (status.category === 'resolved' || status.category === 'closed') {
        const incomplete = await refuseIfIncomplete(row.conversation.customFields);
        if (incomplete) return incomplete;
        const uncaused = await refuseIfNoRootCause(conversationId);
        if (uncaused) return uncaused;
      }

      await changeStatus(agent.id, conversationId, status);
      break;
    }

    case 'assignee': {
      if (!can(agent, 'ticket.assign')) return { error: 'You cannot reassign tickets' };
      const assigneeAgentId = value || null;

      // The picker lists active agents only, but the id comes back as a form
      // field and the picker is not the authority. The foreign key would prove
      // the agent exists; it would not stop a ticket being handed to somebody
      // who has left, where nobody will ever answer it.
      if (assigneeAgentId) {
        if (!isUuid(assigneeAgentId)) return { error: 'Unknown agent' };
        const [assignee] = await db
          .select({ isActive: agents.isActive })
          .from(agents)
          .where(eq(agents.id, assigneeAgentId))
          .limit(1);
        if (!assignee) return { error: 'Unknown agent' };
        if (!assignee.isActive) return { error: 'That agent is deactivated' };
      }

      endedHold = await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ assigneeAgentId, assignedAt: assigneeAgentId ? new Date() : null })
          .where(eq(conversations.id, conversationId));

        await tx.insert(conversationEvents).values({
          conversationId,
          type: assigneeAgentId ? 'assigned' : 'unassigned',
          actorAgentId: agent.id,
          data: { to: assigneeAgentId },
        });

        // A person deciding who answers a ticket held for the router has
        // decided for it (`endHold`). Only by naming somebody, as a rule's
        // `assign_agent` ends one only with an agent: "Unassigned" decides
        // nothing about where the ticket goes — on a held ticket, which has no
        // assignee, it is a no-op write — and ending the hold for it would
        // assign the ticket in its default group, the outcome the hold exists
        // to prevent.
        return assigneeAgentId
          ? endHold(tx, conversationId, 'manual', { agentId: agent.id })
          : false;
      });
      break;
    }

    case 'group': {
      const groupId = value || null;

      // Re-read rather than left to the foreign key, whose violation is a throw
      // and so a blank failure in the console instead of a sentence.
      if (groupId) {
        if (!isUuid(groupId)) return { error: 'Unknown group' };
        const [group] = await db
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.id, groupId))
          .limit(1);
        if (!group) return { error: 'Unknown group' };
      }

      const move = await db.transaction(async (tx) => {
        // Only a move: a page drawn before somebody else moved the ticket can
        // post the group it is already in (`moveToGroupIfElsewhere`).
        if (!(await moveToGroupIfElsewhere(conversationId, groupId, { executor: tx }))) return null;

        // Recorded, where it was not before. Moving a ticket between teams is
        // the same weight of decision as reassigning it and the case above has
        // always written an event; without this one the timeline could say who
        // took a ticket but never how it reached their team.
        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'group_changed',
          actorAgentId: agent.id,
          data: { to: groupId },
        });
        // A person moving a ticket held for the router has decided where it
        // goes (`endHold`).
        return { endedHold: await endHold(tx, conversationId, 'manual', { agentId: agent.id }) };
      });
      if (!move) break;

      // Before anybody has answered, the policy itself may follow the new team
      // (a policy can be keyed on the group); after, it holds. Either way the
      // due dates are then re-counted on the new team's calendar, since groups
      // can keep their own operating days and holidays.
      await afterRoutingChanged(conversationId, { category: false, group: true });

      // The new team may route automatically where the old one did not: the
      // update pass below assigns the ticket, after the observer rules, so a
      // rule that moves it on from here is obeyed before anybody holds it —
      // assigning first left the group the person chose holding a ticket a
      // rule had sent elsewhere. A hold the move ended owes its reply too.
      endedHold = move.endedHold;
      break;
    }

    case 'priority': {
      if (!isPriority(value)) return { error: 'Unknown priority' };

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ priority: value })
          .where(eq(conversations.id, conversationId));

        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'priority_changed',
          actorAgentId: agent.id,
          // After the update above has the row lock (`CHANGE_STAMP`).
          createdAt: CHANGE_STAMP,
          data: { to: value },
        });
      });

      // The policy prices its targets per priority, so the deadline follows the
      // badge rather than staying at whatever the ticket arrived as.
      await onPriorityChanged(conversationId);
      break;
    }

    case 'category': {
      // Its own permission rather than `ticket.edit_fields`, because from Stage
      // 5 this is the field that routes a fresh ticket to a team: a role that
      // may fill in a ticket's questions is not thereby one that moves work
      // between teams. Every agent holds it today.
      if (!can(agent, 'ticket.set_category')) {
        return { error: "You cannot change this ticket's category" };
      }
      const categoryId = value || null;
      if (categoryId && !isUuid(categoryId)) return { error: CATEGORY_REFUSALS.unknown_category };

      const write = await setConversationCategory(conversationId, categoryId, {
        agentId: agent.id,
      });
      if (write.outcome === 'unknown_category' || write.outcome === 'retired_category') {
        return { error: CATEGORY_REFUSALS[write.outcome] };
      }
      if (write.outcome === 'no_ticket') return { error: 'Ticket not found' };

      // During a routing hold a person saying what the ticket is about is the
      // best signal there is, so it routes now, as Jev's answer would: the
      // router runs the rules and chooses the policy itself, and the update
      // pass below would assign before it had. A shadow ticket records where it
      // would have gone and carries on. Clearing the category settles nothing,
      // and the window runs on.
      //
      // The pass below is skipped only where the router owns the rules on the
      // category this edit wrote: `decided` ran them itself, and `failed`
      // left the hold for `settle_routing`, which runs them at the window's
      // end. `in_flight` is another caller's decision part-way through — Jev's
      // answer a moment before this edit — whose pass read the category the
      // edit replaced, and nothing runs the rules again once it ends the hold,
      // so a rule keyed on the new category would never fire. That caller
      // still owns the hold, so the pass is safe to run here: the ticket is
      // held, so its assignment answers `awaiting_route`, and a rule's move
      // ends nothing once phase one is written (`endHold`).
      const routing =
        write.outcome === 'changed' && categoryId
          ? await undecidedRouting(db, conversationId)
          : null;
      if (routing) {
        const routed = await routeNow(conversationId, { agentId: agent.id, label: 'agent' });
        if (!routing.shadow && (routed === 'decided' || routed === 'failed')) {
          routedByCategory = true;
          break;
        }
      }

      // Before the first response, the policy follows the category (it may be
      // keyed on it). A no-op once somebody has answered, when the same policy
      // wins again, or when the ticket already carried the category.
      await afterRoutingChanged(conversationId, {
        category: write.outcome === 'changed',
        group: false,
      });
      break;
    }

    case 'tags': {
      // Split, trim, de-duplicate, drop blanks — the field is free text and
      // "urgent, urgent , " should not become three tags.
      const tags = [
        ...new Set(
          value
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ];

      await db.update(conversations).set({ tags }).where(eq(conversations.id, conversationId));
      break;
    }

    default: {
      // `custom:<key>` — one of the admin-defined ticket fields.
      //
      // The definition is re-read from the database rather than taken from the
      // form: the type decides how the value is parsed and the options decide
      // what is accepted, so a request that could supply either could store an
      // arbitrary value under an arbitrary key and every rule reading it would
      // believe it.
      if (!field.startsWith('custom:')) return { error: `Unknown field "${field}"` };

      if (!can(agent, 'ticket.edit_fields')) {
        return { error: "You cannot edit this ticket's fields" };
      }

      const def = await getTicketField(field.slice('custom:'.length));
      if (!def) return { error: 'Unknown field' };

      const raw = def.type === 'multi_select' ? formData.getAll('value').map(String) : value;
      const parsed = parseFieldValue(def, raw);
      if (!parsed.ok) return { error: parsed.error };

      // Patched in the database rather than read, merged in JavaScript and
      // written back whole. Two agents on the same ticket editing two different
      // fields would otherwise race, and the slower write would carry a stale
      // copy of the other's field and silently undo it — the sidebar saves on
      // every change, so the window is as wide as the round trip.
      //
      // `-` deletes the key instead of storing null. Both read as `is_empty` to
      // the condition language, so this is only about not accumulating keys for
      // fields that were emptied or deleted long ago.
      const patch = isBlank(parsed.value)
        ? sql`${conversations.customFields} - ${def.key}`
        : sql`${conversations.customFields} || ${JSON.stringify({ [def.key]: parsed.value })}::jsonb`;

      const before = row.conversation.customFields[def.key] ?? null;

      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(conversations)
          .set({ customFields: patch })
          .where(eq(conversations.id, conversationId))
          .returning({ customFields: conversations.customFields });

        // The one key that moved, not the whole map: otherwise the timeline says
        // "fields changed" and an agent reading back a week later cannot tell
        // which. Taken from the returned row so it is what was actually stored.
        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'custom_field_changed',
          actorAgentId: agent.id,
          data: {
            key: def.key,
            label: def.label,
            from: before,
            to: updated?.customFields[def.key] ?? null,
          },
        });
      });
      break;
    }
  }

  // Observer rules see the ticket as the agent has just left it. Actions taken
  // by a rule write to the ticket directly and do not come back through here,
  // so a rule cannot trigger itself. Not after a category edit that routed a
  // held ticket, whose router runs them on the category it wrote.
  if (!routedByCategory) await afterTicketUpdate(conversationId);
  // After the rules, so the held reply is told the hours of the group they
  // left the ticket in.
  if (endedHold) await afterHoldEnded(conversationId);

  refresh(row.conversation.number);

  // An agent who sees their own and their groups' tickets can hand this one to
  // somebody in another group, or move it there, and so out of their own sight.
  // The revalidation re-renders the ticket page in this same response, and that
  // page would now call notFound() — so, as `purgeTicket` does, the response
  // carries the inbox instead. Asked after the observer rules, because one of
  // them may have moved it too; free for an agent who sees every ticket.
  // `redirect` throws, so it stays outside any try, and `useFieldAction` takes
  // the rejection it causes on the client as the navigation it is.
  if (!(await seesTicket(agent, conversationId))) redirect('/inbox');
  return ok();
}

// --- Hand to <group> ----------------------------------------------------------

const HAND_TO_REFUSALS: Record<Exclude<HandToResult, { ok: true }>['reason'], string> = {
  not_permitted: 'You cannot reassign tickets',
  not_found: 'Ticket not found',
  not_open: 'Only an open or pending ticket can be handed to another group',
  held: 'This ticket is still being routed. Choose its category to route it now.',
  owned_number:
    "This ticket's WhatsApp number has an owner, who answers it whatever its group. Use the Group field to move it.",
  coexistence:
    'Replies on this number are typed on the phone, so handing the ticket to a group changes nothing',
  no_route: "This ticket's category does not route to a group",
  already_there: "This ticket is already in its category's group",
  changed: "This ticket's category has changed since the page loaded. Check where it routes now.",
  reassigned:
    'Who holds this ticket has changed since the page loaded. Check who it is before handing it over.',
};

/**
 * "Hand to <group>": moves the ticket to its category's route group, clears
 * whoever holds it and assigns it in the new group (`lib/routing/hand-to.ts`).
 *
 * Gated by `ticket.assign`, because it unassigns a colleague and picks
 * somebody else, which is the assignee case's capability. The group comes from
 * the ticket's own category, read under its lock; the form's `groupId` is the
 * group the button named, and is only compared, so a category changed since
 * the page loaded is refused rather than followed somewhere the agent never
 * saw named.
 *
 * The form's `assigneeAgentId` is the assignee the page drew the button from,
 * empty for nobody, and is compared the same way: it decided whether the
 * button asked twice, so a ticket somebody took since the page loaded is
 * refused rather than taken off them in the one click a page showing nobody
 * offers. The refusal re-reads the page, which then asks twice.
 *
 * Nobody to assign — outside the group's hours, a manual strategy, nobody
 * accepting — is still a success, since the ticket is in the group's queue
 * where somebody will look for it; but the agent is told, because the page
 * otherwise shows a ticket the button just unassigned sitting with nobody.
 * Told only then, and of the queue the ticket is really in (`waitsIn`): one a
 * rule moved on before the rota ran is named by where the rule took it, and
 * one a rule resolved, or somebody moved meanwhile, is said nothing of — the
 * route group's queue is not where it waits, and the page drawn with the
 * answer shows where it went.
 */
export async function handToGroup(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.assign')) return { error: HAND_TO_REFUSALS.not_permitted };

  const conversationId = String(formData.get('conversationId') ?? '');
  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: HAND_TO_REFUSALS.not_found };

  // Malformed reads as "not said": it is a staleness check, never the target.
  const expectedGroupId = uuidField(formData, 'groupId') ?? null;
  // Empty, absent and malformed all read as nobody, the strictest answer: it
  // matches only a ticket nobody holds, which the hand-over takes from no one.
  const expectedAssigneeId = uuidField(formData, 'assigneeAgentId') ?? null;

  const handed = await handToRouteGroup(
    conversationId,
    { agentId: agent.id },
    { expectedGroupId, expectedAssigneeId },
  );
  if (!handed.ok) return { error: HAND_TO_REFUSALS[handed.reason] };

  refresh(row.conversation.number);

  // The ticket is in another group now, and for an agent who sees only their
  // own and their groups' tickets that can be out of sight — as the group case
  // in `updateTicket` answers it.
  if (!(await seesTicket(agent, conversationId))) redirect('/inbox');

  if (!handed.waitsIn) return ok();
  return {
    ...ok(),
    // Worded for a manual group as well as a busy or closed one; the Activity
    // list names the hours and the capacity cases (`assignment_skipped`). A
    // rule that moved the ticket on is named by where it took it, since that
    // is the queue the ticket now waits in.
    message: handed.waitsIn.movedOn
      ? `Handed to ${handed.groupName} and then moved on to ${handed.waitsIn.groupName}. Nobody there was given it, so it waits in that group's queue.`
      : `Handed to ${handed.groupName}. Nobody there was given it, so it waits in the group's queue.`,
  };
}

const PURGE_ERRORS: Record<PurgeRefusal, string> = {
  not_found: 'That ticket no longer exists — somebody may have deleted it already',
  confirmation_mismatch: 'That is not the ticket number. Type it exactly as shown.',
};

/**
 * Destroys a ticket and everything on it.
 *
 * The one action in the console with no undo, so it is gated three ways rather
 * than one: `ticket.purge` (admin only, and not inherited from
 * `ticket.view.all`), the channel visibility rule every other ticket action
 * applies, and a typed confirmation of the ticket number that
 * `purgeConversation()` re-derives from the locked row inside its own
 * transaction. The form field is never the authority on what is being deleted —
 * it only has to agree with what the database says.
 *
 * `loadConversation()` is reused deliberately: an admin who cannot see the bot
 * channel must not be able to delete a ticket on it, and that rule already lives
 * in one place. It only covers the ticket on screen, though, and the purge also
 * takes every ticket merged into it — so `hiddenScopeRefusal()` asks the same
 * question of those.
 */
export async function purgeTicket(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.purge')) {
    return { error: 'You do not have permission to delete tickets' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  if (!isUuid(conversationId)) return { error: 'No ticket to delete' };

  const loaded = await loadConversation(agent, conversationId);
  if (!loaded) return { error: PURGE_ERRORS.not_found };

  const hidden = await hiddenScopeRefusal(agent, { conversationId });
  if (hidden) return { error: hidden };

  const result = await purgeConversation({
    conversationId,
    confirmation: String(formData.get('confirmation') ?? ''),
    agent: { id: agent.id, name: agent.name },
  });

  if (!result.ok) return { error: PURGE_ERRORS[result.reason] };

  // Other agents' inboxes stay stale until they navigate — the notify trigger is
  // INSERT/UPDATE only, so a delete raises no event, and adding one would mean a
  // DELETE trigger whose payload names a row nobody can read.
  revalidatePath('/inbox');
  revalidatePath('/contacts');
  revalidatePath('/admin/subcategories/review');

  // The redirect happens here, not in the panel. A server action that
  // revalidates makes Next re-render the route the form was posted from in the
  // same response, and that route is this ticket — whose row is now gone, so
  // its page calls notFound() and the 404 replaces the tree before any client
  // effect could navigate away. A redirect from the action makes the response
  // carry the inbox instead. It throws, so it stays last and outside any try.
  redirect('/inbox');
}

// --- Satisfaction survey ----------------------------------------------------

/**
 * "Don't survey this ticket", and its undo.
 *
 * Any agent who can see the ticket may set it: the harm it prevents — a survey
 * to a colleague, a furious customer, a test — is one the agent on the ticket
 * knows about and nobody else does. The flag is read when the survey job runs,
 * so it works until the moment the survey goes out.
 */
export async function setSurveySuppression(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();

  const conversationId = String(formData.get('conversationId') ?? '');
  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const suppressed = formData.get('suppressed') === 'on';
  if (row.conversation.csatSuppressed === suppressed) {
    refresh(row.conversation.number);
    return ok();
  }

  await setSurveySuppressed(conversationId, agent.id, suppressed);
  refresh(row.conversation.number);
  return ok();
}

/**
 * Queues the survey for a resolved ticket now rather than after the delay.
 *
 * Queued, not sent: `send_csat` makes every check the scheduled survey makes,
 * so this cannot reach a customer the automatic one would not, and the outcome
 * lands on the timeline the same way. Open to any agent who can see the
 * ticket, as the suppression toggle is: agents resolve tickets, and a control
 * offered to a role it always refuses is worse than none.
 */
export async function sendSurveyNow(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();

  const conversationId = String(formData.get('conversationId') ?? '');
  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  if (row.statusCategory !== 'resolved' && row.statusCategory !== 'closed') {
    return { error: 'Only a resolved ticket can be surveyed' };
  }

  const outcome = await scheduleSurvey(conversationId, 'manual');
  if (outcome === 'off') return { error: 'Surveys are switched off' };
  if (outcome === 'channel_off') return { error: 'Surveys are off for this channel' };
  if (outcome === 'channel_unsupported') return { error: 'Surveys are not sent on this channel' };
  if (outcome !== 'queued') return { error: 'The survey could not be queued' };

  refresh(row.conversation.number);
  return ok();
}
