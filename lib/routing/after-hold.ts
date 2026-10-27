import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { routingDecisions } from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { maybeSendAutoResponse } from '@/lib/auto-response';
import { logger } from '@/lib/log';

const log = logger('routing');

/**
 * What a hold owed once it is over, whatever ended it — the router's decision,
 * `settle_routing`, or a person or rule through `endHold`: the assignment the
 * creation pass held back, and its out-of-hours reply, to the message that
 * opened the ticket — the one it would have answered had nothing been held.
 *
 * Owed by state rather than by one caller, so every way a hold ends calls this
 * once its own transaction has committed. The reply's claim on
 * `auto_responded_at` keeps it to one, and its guards to a ticket still open
 * that nobody has answered — so an agent's reply that ended the hold at 23:00
 * is not followed by "we are closed".
 *
 * Best-effort, like every lifecycle step: these run inside jobs and actions,
 * and a throw would fail what has already been written.
 *
 * Not in `apply.ts`, which imports the automation engine: the engine calls this
 * after a pass whose rule ended a hold, and would import itself.
 */
export async function afterHoldEnded(
  conversationId: string,
  messageId?: string | null,
  now: Date = new Date(),
): Promise<void> {
  try {
    await assignConversation(conversationId, { now });
  } catch (error) {
    log.error(`auto-assignment failed for conversation ${conversationId}`, error);
  }

  try {
    const opening = messageId === undefined ? await openingMessage(conversationId) : messageId;
    if (opening) await maybeSendAutoResponse({ conversationId, messageId: opening }, now);
  } catch (error) {
    log.error(`could not send the held reply on ${conversationId}`, error);
  }
}

async function openingMessage(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ messageId: routingDecisions.messageId })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId));
  return row?.messageId ?? null;
}
