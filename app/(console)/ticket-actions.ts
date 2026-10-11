'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, conversationEvents, conversations, groups, ticketStatuses } from '@/db/schema';
import { purgeConversation, type PurgeRefusal } from '@/lib/admin/purge';
import { hiddenScopeRefusal } from '@/lib/admin/purge-visibility';
import { assignConversation } from '@/lib/assignment';
import { requireAgent } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { isUuid } from '@/lib/http/uuid';
import { can } from '@/lib/auth/permissions';
import { isPriority } from '@/lib/tickets/vocabulary';
import { onGroupChanged, onPriorityChanged } from '@/lib/sla';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { PRIORITY_STAMP } from '@/lib/tickets/priority-stamp';
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
import type { ActionState } from './action-state';

// --- Ticket properties ------------------------------------------------------

export async function updateTicket(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();

  const conversationId = String(formData.get('conversationId') ?? '');
  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const field = String(formData.get('field') ?? '');
  const value = String(formData.get('value') ?? '');

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
      // then dated, since `resolved_at` stays null on this path.
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

      await db.transaction(async (tx) => {
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

      await db.transaction(async (tx) => {
        await tx.update(conversations).set({ groupId }).where(eq(conversations.id, conversationId));

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
      });

      // Groups can keep their own operating days and holidays, so the due dates
      // are re-counted on the new team's calendar rather than left pointing at
      // hours that team does not work.
      await onGroupChanged(conversationId);

      // The new team may route automatically where the old one did not. A no-op
      // if somebody already holds the ticket, which is the usual case.
      await assignConversation(conversationId, { actorLabel: 'auto_assign' });
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
          // After the update above has the row lock (`PRIORITY_STAMP`).
          createdAt: PRIORITY_STAMP,
          data: { to: value },
        });
      });

      // The policy prices its targets per priority, so the deadline follows the
      // badge rather than staying at whatever the ticket arrived as.
      await onPriorityChanged(conversationId);
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
  // so a rule cannot trigger itself.
  await afterTicketUpdate(conversationId);

  refresh(row.conversation.number);
  return ok();
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
  revalidatePath('/admin/categories/review');

  // The redirect happens here, not in the panel. A server action that
  // revalidates makes Next re-render the route the form was posted from in the
  // same response, and that route is this ticket — whose row is now gone, so
  // its page calls notFound() and the 404 replaces the tree before any client
  // effect could navigate away. A redirect from the action makes the response
  // carry the inbox instead. It throws, so it stays last and outside any try.
  redirect('/inbox');
}
