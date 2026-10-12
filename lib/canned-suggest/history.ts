import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { attachments, messages } from '@/db/schema';
import { HISTORY_LIMIT, type HistoryAuthor, type HistoryMessage } from './request';

/**
 * The conversation so far, as Jev is shown it.
 *
 * Read here, on the server, from the ticket — never taken from the browser,
 * which holds the same timeline and could post it. A posted history is a claim
 * about what the customer said, and it would be what a third party receives.
 *
 * Replies only, in both directions. A note is an agent's private working — it
 * names colleagues, quotes the merchant's account, says what the team suspects —
 * and it does not leave the building for a suggestion. `system` rows are our own
 * bookkeeping and a `forward` is a copy sent elsewhere; neither is the
 * conversation the next reply continues.
 */

export type ConversationHistory = {
  /** Oldest first, at most `HISTORY_LIMIT`. */
  messages: HistoryMessage[];
  /**
   * The newest reply, whichever way it went: the last message Jev is shown, and
   * so the cache key — the same anchor is the same input.
   *
   * The composer computes the same value from the timeline it already holds,
   * ordered the same way (`created_at`, then `id`), so the two agree on which
   * suggestion is current without the browser having to ask.
   */
  anchorMessageId: string | null;
  /** Whether a customer said anything in what was read. Nothing to answer otherwise. */
  hasInbound: boolean;
};

export async function readHistory(conversationId: string): Promise<ConversationHistory> {
  const rows = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      authorAgentId: messages.authorAgentId,
      bodyText: messages.bodyText,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.kind, 'reply')))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(HISTORY_LIMIT);

  const newest = rows[0];
  if (!newest) return { messages: [], anchorMessageId: null, hasInbound: false };

  const files = await db
    .select({ messageId: attachments.messageId, n: count() })
    .from(attachments)
    .where(
      inArray(
        attachments.messageId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(attachments.messageId);
  const filesFor = new Map(files.map((file) => [file.messageId, file.n]));

  const oldestFirst = [...rows].reverse();

  return {
    messages: oldestFirst.map((row) => ({
      from: authorOf(row.direction, row.authorAgentId),
      text: row.bodyText,
      attachments: filesFor.get(row.id) ?? 0,
    })),
    anchorMessageId: newest.id,
    hasInbound: rows.some((row) => row.direction === 'inbound'),
  };
}

/**
 * Outbound with no author is the software talking — an automation's canned
 * reply, the out-of-hours acknowledgement — and `lib/tickets/outbound.ts`
 * writes those without one. Labelling it as an agent would tell Jev the
 * customer had already been answered by a person.
 */
function authorOf(direction: 'inbound' | 'outbound', authorAgentId: string | null): HistoryAuthor {
  if (direction === 'inbound') return 'customer';
  return authorAgentId ? 'support_agent' : 'automatic_message';
}
