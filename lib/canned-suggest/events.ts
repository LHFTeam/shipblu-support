import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { cannedSuggestions } from '@/db/schema';
import { isUuid } from '@/lib/http/uuid';
import type { SuggestionEvent } from './types';

/**
 * What the agent did with a suggestion before sending anything: saw it, took it,
 * or waved it away.
 *
 * The id arrives from the browser, so the row is matched on it *and* on the
 * agent: an agent can only ever mark their own suggestions, and an id that is
 * somebody else's answers exactly like one that does not exist.
 *
 * Every timestamp is first-write-wins (`coalesce`). The composer reports
 * `shown` once per suggestion, but a remount after a tab switch shows the same
 * row again, and the second report must not move the first.
 *
 * A row already linked to a reply is closed: what happened is settled by what
 * was sent, and an event arriving late from a stale tab must not rewrite it.
 */

export const SUGGESTION_EVENTS = [
  'shown',
  'accepted',
  'dismissed',
] as const satisfies readonly SuggestionEvent[];

const now = sql`now()`;

/**
 * Taking a suggestion implies having seen it — the Use button and the Tab key
 * only act while the ghost text is on screen — so `shown_at` is set too, in case
 * the `shown` report was lost on the way. Taking one is refused once it was
 * waved away, and the other way round; `db/sql/003_constraints.sql` holds the
 * same line for a request the composer did not make. Neither applies to a
 * `none`, which has nothing to take.
 */
const CHANGES: Record<
  SuggestionEvent,
  { set: PgUpdateSetSource<typeof cannedSuggestions>; when: SQL | undefined }
> = {
  shown: {
    set: { shownAt: sql`coalesce(${cannedSuggestions.shownAt}, ${now})` },
    when: isNotNull(cannedSuggestions.cannedResponseId),
  },
  accepted: {
    set: {
      shownAt: sql`coalesce(${cannedSuggestions.shownAt}, ${now})`,
      acceptedAt: sql`coalesce(${cannedSuggestions.acceptedAt}, ${now})`,
    },
    when: and(isNotNull(cannedSuggestions.cannedResponseId), isNull(cannedSuggestions.dismissedAt)),
  },
  dismissed: {
    set: {
      shownAt: sql`coalesce(${cannedSuggestions.shownAt}, ${now})`,
      dismissedAt: sql`coalesce(${cannedSuggestions.dismissedAt}, ${now})`,
    },
    when: and(isNotNull(cannedSuggestions.cannedResponseId), isNull(cannedSuggestions.acceptedAt)),
  },
};

/**
 * Records the event, and says whether the suggestion is this agent's at all —
 * the route's 204 against its 404. A suggestion that is the agent's but cannot
 * take this event (already sent, already waved away) is still theirs: nothing
 * changes, and nothing about that is an error the composer could act on.
 */
export async function recordSuggestionEvent(
  agentId: string,
  suggestionId: string,
  event: SuggestionEvent,
): Promise<boolean> {
  if (!isUuid(suggestionId)) return false;

  const mine = and(eq(cannedSuggestions.id, suggestionId), eq(cannedSuggestions.agentId, agentId));
  const change = CHANGES[event];

  const updated = await db
    .update(cannedSuggestions)
    .set(change.set)
    .where(and(mine, isNull(cannedSuggestions.repliedAt), change.when))
    .returning({ id: cannedSuggestions.id });
  if (updated.length > 0) return true;

  const [exists] = await db
    .select({ id: cannedSuggestions.id })
    .from(cannedSuggestions)
    .where(mine)
    .limit(1);
  return Boolean(exists);
}
