import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses, cannedSuggestions } from '@/db/schema';
import { logger } from '@/lib/log';
import type { CannedUse } from '@/lib/tickets/canned-usage';
import { cannedVisibleTo } from '@/lib/tickets/lookups';
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
 * "Carried" is every canned response inserted since the box was last empty,
 * not only the last one. `usage_count` is last-one-wins on purpose — it counts
 * replies — but a grade read off the last pick would mark Jev wrong every time
 * an agent took its suggestion and then added a closing from the list, which is
 * what the starter library's two closings are for.
 *
 * The comparison is frozen here, at send time, into `sent_choice`,
 * `sent_matches` and `sent_edit`. A canned response deleted next month must not
 * re-grade a suggestion made this month, and the titles go into text columns
 * beside their foreign keys for the same reason.
 *
 * `used` is what `recordCannedUse` counted — the same read, through the same
 * visibility rule — so the usage column and this grade cannot disagree about
 * the last response a reply carried. `inserted` is the composer's list of every
 * one, and like every form field only a claim: it is only ever compared with
 * the choice the server stored, and a response it names is re-read through
 * `cannedVisibleTo` before its title or text is recorded.
 */
export async function recordSuggestionOutcome(
  agentId: string,
  suggestionId: string,
  reply: {
    conversationId: string;
    messageId: string;
    body: string;
    used: CannedUse | null;
    inserted: readonly string[];
  },
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
      .select({ choice: cannedSuggestions.choice, cannedTitle: cannedSuggestions.cannedTitle })
      .from(cannedSuggestions)
      .where(open)
      .limit(1);
    if (!row?.choice) return;

    const { used } = reply;
    const inserted = new Set(reply.inserted);
    if (used) inserted.add(used.id);

    const grade = await gradeOf(agentId, row.choice, row.cannedTitle, inserted, used, reply.body);

    await db
      .update(cannedSuggestions)
      .set({ messageId: reply.messageId, repliedAt: new Date(), ...grade })
      .where(open);
  } catch (error) {
    // Never the reason a reply fails: it is stored and queued by the time this
    // runs. A lost link is one row missing from a report.
    log.warn(`could not link a reply to suggestion=${suggestionId}`, error);
  }
}

type Grade = {
  sentChoice: string;
  sentMatches: boolean;
  sentCannedResponseId: string | null;
  sentCannedTitle: string | null;
  sentLocale: string | null;
  sentEdit: 'unchanged' | 'extended' | 'reworded' | null;
};

async function gradeOf(
  agentId: string,
  choice: string,
  frozenTitle: string | null,
  inserted: ReadonlySet<string>,
  used: CannedUse | null,
  body: string,
): Promise<Grade> {
  // `none` is right when the reply carried no canned response at all.
  if (choice === NONE_KEY) {
    const carried = used?.id ?? [...inserted].at(-1) ?? null;
    return {
      sentChoice: carried ?? NONE_KEY,
      sentMatches: carried === null,
      sentCannedResponseId: used?.id ?? null,
      sentCannedTitle: used?.title ?? null,
      sentLocale: used?.locale ?? null,
      sentEdit: null,
    };
  }

  if (!inserted.has(choice)) {
    return {
      sentChoice: used?.id ?? [...inserted].at(-1) ?? NONE_KEY,
      sentMatches: false,
      sentCannedResponseId: used?.id ?? null,
      sentCannedTitle: used?.title ?? null,
      sentLocale: used?.locale ?? null,
      sentEdit: null,
    };
  }

  // The reply carried Jev's choice. Its title and text are read here rather
  // than taken from `used`, which may be a closing added after it; and read
  // through the composer's rule, so a claimed id the agent could not have
  // inserted records nothing about that response. A response deleted since
  // keeps the title frozen when it was suggested, and no edit grade.
  const [response] = await db
    .select({
      title: cannedResponses.title,
      ar: cannedResponses.bodyTextAr,
      en: cannedResponses.bodyTextEn,
    })
    .from(cannedResponses)
    .where(and(eq(cannedResponses.id, choice), cannedVisibleTo(agentId)))
    .limit(1);

  // The language is known only when the choice was the last insert, which is
  // the one `recordCannedUse` resolved; otherwise both bodies are tried.
  const locale = used?.id === choice ? used.locale : null;
  return {
    sentChoice: choice,
    sentMatches: true,
    sentCannedResponseId: response ? choice : null,
    sentCannedTitle: response?.title ?? frozenTitle,
    sentLocale: locale,
    sentEdit: response
      ? editKind(body, locale ? [response[locale]] : [response.ar, response.en])
      : null,
  };
}
