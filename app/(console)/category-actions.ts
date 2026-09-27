'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationCategories,
  conversationEvents,
  conversations,
  ticketCategories,
  ticketRootCauses,
} from '@/db/schema';
import { refreshPrimary } from '@/lib/categorise/apply';
import { requireAgent } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { can } from '@/lib/auth/permissions';
import type { SessionAgent } from '@/lib/auth/session';
import { loadConversation, refresh } from '@/lib/tickets/console-guards';
import type { ActionState } from './actions';

// --- Categories and root cause ----------------------------------------------

/**
 * An agent's answer to what the detector proposed.
 *
 * Four verbs on a category, and the shape of each is the human-in-the-loop
 * design rather than CRUD on a join table:
 *
 * - **confirm** says the rule was right, and keeps the `confidence` and
 *   `rule_key` it asserted. Those are what the tuning pass measures; clearing
 *   them on confirmation would destroy the only record of whether the rule was
 *   any good.
 * - **reject** says it was wrong, and **keeps the row**. A rejected assignment
 *   still occupies `(conversation, category)`, which is what stops the next
 *   message re-suggesting it — the agent's judgement survives without a single
 *   `where` clause anywhere having to remember it.
 * - **add** is a person filing what the rules missed, which is the other half of
 *   the same signal: a category arriving by hand far more often than by rule is
 *   a gap in the lexicon.
 * - **remove** takes back an agent's own addition, and is the one path that
 *   deletes — there is nothing to learn from somebody undoing their own click.
 */
type CategoryTarget =
  | { ok: false; error: string }
  | {
      ok: true;
      agent: SessionAgent;
      conversationId: string;
      categoryId: string;
      category: { id: string; key: string };
      number: number;
    };

async function resolveCategoryTarget(formData: FormData): Promise<CategoryTarget> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.categorise')) {
    return { ok: false, error: 'You do not have permission to categorise tickets' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const categoryId = String(formData.get('categoryId') ?? '');
  if (!conversationId || !categoryId) return { ok: false, error: 'Choose a category' };

  // Re-read both sides rather than trusting the ids in the form: the
  // conversation so channel visibility is checked at this entry point too, and
  // the category so a request naming a row that has since gone fails instead of
  // writing a dangling assignment.
  const row = await loadConversation(agent, conversationId);
  if (!row) return { ok: false, error: 'Ticket not found' };

  const category = await db
    .select({ id: ticketCategories.id, key: ticketCategories.key })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, categoryId))
    .limit(1);

  if (!category[0]) return { ok: false, error: 'That category no longer exists' };

  return {
    ok: true,
    agent,
    conversationId,
    categoryId,
    category: category[0],
    number: row.conversation.number,
  };
}

export async function addCategory(_state: ActionState, formData: FormData): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  // `onConflictDoUpdate` rather than `DoNothing`, and this is the one path
  // allowed to overturn a rejection: a person adding a category the detector
  // suggested, or that somebody previously threw out, is making an explicit
  // decision and it should win.
  const claim = {
    source: 'manual' as const,
    reviewState: 'confirmed' as const,
    confidence: 1,
    assignedByAgentId: agent.id,
    reviewedByAgentId: agent.id,
    reviewedAt: new Date(),
  };

  await db
    .insert(conversationCategories)
    .values({ conversationId, categoryId, categoryKey: category.key, ...claim })
    .onConflictDoUpdate({
      target: [conversationCategories.conversationId, conversationCategories.categoryId],
      set: claim,
    });

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_added',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

export async function confirmCategory(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  await db
    .update(conversationCategories)
    .set({ reviewState: 'confirmed', reviewedByAgentId: agent.id, reviewedAt: new Date() })
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.categoryId, categoryId),
      ),
    );

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_confirmed',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

export async function rejectCategory(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  // A state change, never a delete. `source` is left alone so a report can tell
  // "a rule was thrown out" from "an agent removed their own", and `is_primary`
  // is cleared in the same statement because a CHECK forbids a rejected row
  // from being one.
  await db
    .update(conversationCategories)
    .set({
      reviewState: 'rejected',
      isPrimary: false,
      reviewedByAgentId: agent.id,
      reviewedAt: new Date(),
    })
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.categoryId, categoryId),
      ),
    );

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_rejected',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

export async function removeCategory(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  // Scoped to `manual`: deleting a detected row would throw away the evidence
  // that a rule fired, which is what the tuning pass reads. A detected row is
  // rejected instead.
  await db
    .delete(conversationCategories)
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.categoryId, categoryId),
        eq(conversationCategories.source, 'manual'),
      ),
    );

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_removed',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

/**
 * Why this ticket happened, recorded by the agent who looked into it.
 *
 * Accepts an empty value so a cause set by mistake can be cleared — the resolve
 * gate will ask again, which is the right outcome for a ticket somebody is
 * still working out.
 */
export async function setRootCause(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.categorise')) {
    return { error: 'You do not have permission to categorise tickets' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const rootCauseId = String(formData.get('rootCauseId') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  let key: string | null = null;
  if (rootCauseId) {
    const cause = await db
      .select({ key: ticketRootCauses.key })
      .from(ticketRootCauses)
      .where(eq(ticketRootCauses.id, rootCauseId))
      .limit(1);
    if (!cause[0]) return { error: 'That root cause no longer exists' };
    key = cause[0].key;
  }

  await db
    .update(conversations)
    .set({
      rootCauseId: rootCauseId || null,
      // Cleared with the cause, so a ticket whose cause was removed cannot be
      // counted on the day the removed one was established.
      rootCauseSetAt: rootCauseId ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'root_cause_set',
    actorAgentId: agent.id,
    data: { rootCauseKey: key },
  });

  refresh(row.conversation.number);
  return ok();
}
