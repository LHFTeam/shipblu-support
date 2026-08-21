import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentFocusIntervals, conversationPresence, conversations } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { conversationVisibility } from '@/lib/tickets/queries';

/**
 * How long an agent actually had a ticket in front of them.
 *
 * The console beats while a ticket is open, focused and being used; this is the
 * half that decides what that beat means. Nothing else measures handling time —
 * a ticket carries no timer, and the gap between two replies is mostly the
 * customer thinking.
 *
 * The same beat also refreshes `conversation_presence`, which has existed since
 * the beginning for collision detection and has never had a writer. That is not
 * a free extra: it is the reason the beat is worth having from the agent's side
 * rather than only from the supervisor's, because it is what lets the ticket
 * say somebody else is already looking at this.
 */

/**
 * How stale a focus beat may get before the span is treated as finished.
 *
 * The beat is every 30 seconds, so this is two missed ones. Tighter than the
 * presence heartbeat's tolerance on purpose: presence is asking "did they close
 * the laptop", which deserves patience, and this is asking "are they still
 * reading this ticket", which does not — a minute and a half of nothing is
 * somebody who has walked away, and counting it inflates the very number the
 * report exists to measure.
 */
export const FOCUS_TTL_MS = 90 * 1000;

/**
 * Record that this agent is working this ticket right now.
 *
 * The conversation id arrives from a browser, so it is re-checked against the
 * agent's own visibility rule rather than trusted — the same rule the ticket
 * page itself applies. Without that, the endpoint would be a way to find out
 * whether a ticket exists by watching which ids it accepts, and an agent
 * restricted to their own tickets could write focus rows against anybody's.
 *
 * Returns false when the ticket is not theirs to look at, which the caller
 * reports as a 404 for the same reason the page does: not found and not allowed
 * should be indistinguishable.
 */
export async function recordFocus(agent: SessionAgent, conversationId: string): Promise<boolean> {
  const visible = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), ...conversationVisibility(agent)))
    .limit(1);

  if (visible.length === 0) return false;

  const now = new Date();
  const fresh = new Date(now.getTime() - FOCUS_TTL_MS);

  // Anything the agent had open on a *different* ticket is over: they are
  // looking at this one. Closing it here rather than waiting for it to go stale
  // is what stops two tickets from claiming the same minute, which would put
  // occupancy above 100% and quietly make the ratio meaningless.
  await db
    .update(agentFocusIntervals)
    .set({ endedAt: sql`least(now(), ${agentFocusIntervals.lastBeatAt} + interval '90 seconds')` })
    .where(
      and(
        eq(agentFocusIntervals.agentId, agent.id),
        isNull(agentFocusIntervals.endedAt),
        sql`${agentFocusIntervals.conversationId} <> ${conversationId}`,
      ),
    );

  const extended = await db
    .update(agentFocusIntervals)
    .set({ lastBeatAt: now })
    .where(
      and(
        eq(agentFocusIntervals.agentId, agent.id),
        eq(agentFocusIntervals.conversationId, conversationId),
        isNull(agentFocusIntervals.endedAt),
        gte(agentFocusIntervals.lastBeatAt, fresh),
      ),
    )
    .returning({ id: agentFocusIntervals.id });

  if (extended.length === 0) {
    // Seal anything stale at its last beat before opening a new span, so a
    // browser that was closed without a sign-off contributes the time it can
    // actually account for and not the hours since.
    await db
      .update(agentFocusIntervals)
      .set({ endedAt: sql`${agentFocusIntervals.lastBeatAt}` })
      .where(
        and(
          eq(agentFocusIntervals.agentId, agent.id),
          isNull(agentFocusIntervals.endedAt),
          lt(agentFocusIntervals.lastBeatAt, fresh),
        ),
      );

    await db
      .insert(agentFocusIntervals)
      .values({ agentId: agent.id, conversationId, startedAt: now, lastBeatAt: now });
  }

  // Collision detection. Disposable by design — the hourly cleanup sweeps it —
  // so a failure here must not cost the measurement above.
  try {
    await db
      .insert(conversationPresence)
      .values({ conversationId, agentId: agent.id, updatedAt: now })
      .onConflictDoUpdate({
        target: [conversationPresence.conversationId, conversationPresence.agentId],
        set: { updatedAt: now },
      });
  } catch (error) {
    console.error('[focus] could not refresh conversation presence', error);
  }

  return true;
}

/**
 * The agent stopped looking — they navigated away, hid the tab, or went idle.
 *
 * Sent on a best effort basis by the page, and never relied upon: a browser that
 * is closed outright sends nothing, which is what the staleness fallback above
 * is for. What this buys is precision at the end of the span, so a ticket read
 * for ten seconds does not cost the agent ninety.
 */
export async function releaseFocus(agentId: string, conversationId: string): Promise<void> {
  await db
    .update(agentFocusIntervals)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(agentFocusIntervals.agentId, agentId),
        eq(agentFocusIntervals.conversationId, conversationId),
        isNull(agentFocusIntervals.endedAt),
      ),
    );
}
