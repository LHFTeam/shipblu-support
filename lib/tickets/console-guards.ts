import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  contacts,
  conversationCategories,
  conversations,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { can } from '@/lib/auth/permissions';
import type { SessionAgent } from '@/lib/auth/session';
import { CAUSE_REQUIRED_AREAS } from '@/lib/categorise/taxonomy';
import type { ActionState } from '@/lib/http/action-state';
import { isUuid } from '@/lib/http/uuid';
import { canSeeChannel, readOnlyReason } from '@/lib/tickets/channel-policy';
import { listLabels, missingRequired } from '@/lib/tickets/custom-fields';
import { listTicketFields } from '@/lib/tickets/lookups';
import { changeStatus } from '@/lib/tickets/status';

/**
 * The checks every console ticket action shares: load the ticket as the agent
 * may see it, refuse what the ticket's state forbids, and revalidate the pages
 * a write stales.
 *
 * A plain module rather than part of the console's action files, because those
 * are `'use server'` and every export there is a public POST endpoint. These
 * are helpers the actions call after they authorise; exported from an action
 * file, each one would be callable on its own, with no `requireAgent()` in
 * front of it. Moving them here is what lets the actions split into sibling
 * files that share them.
 *
 * They return the base `ActionState`. The console's own adds an optional
 * `message`, so every value here is also one of those.
 */

export async function loadConversation(agent: SessionAgent, conversationId: string) {
  // Every action on a ticket starts here with an id out of a form field. A
  // malformed one is a ticket that does not exist, not a 22P02 thrown out of
  // the action — which returns no state, so the agent saw a blank failure.
  if (!isUuid(conversationId)) return null;

  const rows = await db
    .select({
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      requesterEmail: contacts.primaryEmail,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Same visibility rule as the read path, re-checked here: an action is a
  // separate entry point and must not trust that the page filtered anything.
  if (!can(agent, 'ticket.view.all') && row.conversation.assigneeAgentId !== agent.id) {
    return null;
  }

  if (!canSeeChannel(agent, row.conversation.channel)) return null;

  return row;
}

/**
 * Refuses a write to a channel the platform only observes.
 *
 * Checked in the actions rather than only in the composer: hiding the textarea
 * stops the honest path, and this stops the other ones — a stale tab open from
 * before the channel existed, a resubmitted form, a hand-made POST.
 */
export function refuseIfReadOnly(channel: string): ActionState | null {
  const reason = readOnlyReason(channel);
  return reason ? { error: reason } : null;
}

export function refresh(number: number) {
  revalidatePath(`/inbox/${number}`);
  revalidatePath('/inbox');
  // The category review queue is a view onto these tickets' categories, so any
  // ticket write can stale it. Here rather than in each action, for the reason
  // channel-policy.ts gives about rules spread across call sites.
  revalidatePath('/admin/categories/review');
}

/**
 * Refuses to resolve a ticket whose required fields are still empty.
 *
 * `required_on_resolve` was written by the admin form and read by nothing since
 * the first migration, so a field marked required could be left empty
 * everywhere. This is the gate that makes the flag mean something.
 *
 * Deliberately only on the agent's own path. An automation or an SLA escalation
 * that resolves a ticket is not stopped by it: a rule cannot fill a field in, so
 * enforcing it there would leave tickets wedged in a state no human was asked to
 * clear, and the flag is about what a person must record before calling it done.
 */
export async function refuseIfIncomplete(
  customFields: Record<string, unknown>,
): Promise<ActionState | null> {
  const missing = missingRequired(await listTicketFields(), customFields, 'resolve');
  if (!missing.length) return null;

  return {
    error: `Fill in ${listLabels(missing)} before resolving this ticket`,
  };
}

/**
 * Refuses to resolve a ticket that went wrong without saying why.
 *
 * The root cause is the dimension the business acts on — a category report says
 * what the queue is full of, and only this says what to go and fix — and it
 * cannot be detected, because the customer does not know it. Which means the
 * only moment it can be captured is the one where somebody has just finished
 * looking into the ticket.
 *
 * Only for the areas where something actually failed. A price-list question or
 * an integration walkthrough has no cause, and demanding one would teach agents
 * to pick whatever clears the dialogue — which is how a dimension fills up with
 * noise and stops being worth reporting on.
 *
 * On the agent's own path only, exactly as `refuseIfIncomplete` is: an
 * automation cannot know why a parcel was late, so enforcing this against the
 * three-day auto-close would wedge tickets in a state no person was asked to
 * clear.
 *
 * The list of areas lives in `lib/categorise/taxonomy.ts` because the coverage
 * figure on the report has to measure the same population this gate demands —
 * two definitions of "owes a cause" is how a report comes to say 40% of tickets
 * are missing something that was never asked of most of them.
 */
export async function refuseIfNoRootCause(conversationId: string): Promise<ActionState | null> {
  const rows = await db
    .select({
      rootCauseId: conversations.rootCauseId,
      area: ticketCategories.area,
    })
    .from(conversations)
    .leftJoin(
      conversationCategories,
      and(
        eq(conversationCategories.conversationId, conversations.id),
        eq(conversationCategories.isPrimary, true),
      ),
    )
    .leftJoin(ticketCategories, eq(ticketCategories.id, conversationCategories.categoryId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.rootCauseId) return null;
  if (!row.area || !CAUSE_REQUIRED_AREAS.includes(row.area)) return null;

  return { error: 'Record what caused this before closing it' };
}

/**
 * Used by "reply and resolve", which should not need a second round trip.
 *
 * `closed` is absent from the union on purpose. It is the one category behind a
 * permission (`ticket.close`), and this function takes a category rather than a
 * status id from a form, so a future caller passing 'closed' would be a closure
 * that skipped the check in `updateTicket` with nothing to notice it. Leaving it
 * out makes that a compile error instead of a hole.
 */
export async function applyStatusCategory(
  agent: SessionAgent,
  conversationId: string,
  category: 'open' | 'pending' | 'resolved',
): Promise<void> {
  const rows = await db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      stopsSlaClock: ticketStatuses.stopsSlaClock,
    })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.category, category))
    .orderBy(ticketStatuses.position)
    .limit(1);

  const status = rows[0];
  if (!status) return;

  await changeStatus(agent.id, conversationId, { ...status, category }, 'reply_and_resolve');
}
