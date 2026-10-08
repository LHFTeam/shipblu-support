import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedSuggestions } from '@/db/schema';
import { logger } from '@/lib/log';
import type { CannedUse } from '@/lib/tickets/canned-usage';
import { editKind } from './edit';
import { NONE_KEY } from './request';

const log = logger('canned_suggest');

/**
 * Linking a sent reply to the suggestion its composer was showing, and grading
 * Jev on it.
 *
 * Correct means the reply carried the canned response Jev chose — taken with
 * Tab or picked by hand from the list, edited or not — and a reply that carried
 * none after Jev said `none` is correct too. That is the definition the report
 * prints, decided when this was built: it scores the suggestion against what
 * the agent actually sent, not against what they clicked.
 *
 * The comparison is frozen here, at send time, into `sent_matches` and
 * `sent_edit`. A canned response deleted next month must not re-grade a
 * suggestion made this month, and the titles go into text columns beside their
 * foreign keys for the same reason.
 *
 * `used` is what `recordCannedUse` counted — the same read, through the same
 * visibility rule — so the usage column and this grade cannot disagree about
 * which response a reply carried.
 */
export async function recordSuggestionOutcome(
  agentId: string,
  suggestionId: string,
  reply: { conversationId: string; messageId: string; body: string; used: CannedUse | null },
): Promise<void> {
  try {
    // The id came in a form field, so it is matched on the agent and the ticket
    // as well: a suggestion from another tab's ticket, or somebody else's, links
    // nothing. Only an answered, unlinked suggestion can take an outcome — a
    // resubmitted send finds it linked already and leaves it alone.
    const open = and(
      eq(cannedSuggestions.id, suggestionId),
      eq(cannedSuggestions.agentId, agentId),
      eq(cannedSuggestions.conversationId, reply.conversationId),
      isNotNull(cannedSuggestions.choice),
      isNull(cannedSuggestions.repliedAt),
    );

    const [row] = await db
      .select({ choice: cannedSuggestions.choice })
      .from(cannedSuggestions)
      .where(open)
      .limit(1);
    if (!row?.choice) return;

    const { used } = reply;
    const sentChoice = used?.id ?? NONE_KEY;
    const matches = row.choice === sentChoice;

    await db
      .update(cannedSuggestions)
      .set({
        messageId: reply.messageId,
        repliedAt: new Date(),
        sentCannedResponseId: used?.id ?? null,
        sentCannedTitle: used?.title ?? null,
        sentLocale: used?.locale ?? null,
        sentMatches: matches,
        sentEdit:
          matches && used
            ? editKind(
                reply.body,
                used.locale ? [used.bodies[used.locale]] : [used.bodies.ar, used.bodies.en],
              )
            : null,
      })
      .where(open);
  } catch (error) {
    // Never the reason a reply fails: it is stored and queued by the time this
    // runs. A lost link is one row missing from a report.
    log.warn(`could not link a reply to suggestion=${suggestionId}`, error);
  }
}
