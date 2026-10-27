import { and, asc, count, desc, eq, inArray, max, min, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiCategoryRuns, conversationEvents, conversations, jobs } from '@/db/schema';
import { listCategories } from '@/lib/categories/queries';
import { CATEGORY_OUTCOMES, type CategoryOutcome } from './decide';
import { grade, type Grading, type GradingTicket } from './grade';

/**
 * The reads behind `/reports/category-ai`: which run labels and questions
 * there are to choose from, and, for the one chosen, every row, every
 * `category_changed` on the tickets they name, and those tickets' numbers.
 * `grade.ts` does the judging, so nothing here decides what counts.
 *
 * One label and one question at a time (`plans/ticket-category-routing.md`,
 * 4.2): a label holds the answers one run gave, and a question edited on
 * `/admin/categories` is a different question, which no figure may average with
 * the one before it.
 *
 * Read whole rather than counted in SQL. A label is at most every customer
 * message since the archive starts — tens of thousands of narrow rows — and the
 * grading walks each ticket's rows in order, which is a loop in code and a
 * window function nobody could review in SQL.
 */

/** Thresholds every sweep shows; the ones in force are added to them. */
const SWEEP_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** One label and question to choose from, newest first. */
export type RunQuestion = {
  runLabel: string;
  fingerprint: string;
  rows: number;
  tickets: number;
  modes: string[];
  firstMessageAt: Date;
  lastMessageAt: Date;
  lastWrittenAt: Date;
};

export async function runQuestions(): Promise<RunQuestion[]> {
  const rows = await db
    .select({
      runLabel: aiCategoryRuns.runLabel,
      fingerprint: aiCategoryRuns.requestFingerprint,
      rows: count(),
      tickets: sql<number>`count(distinct ${aiCategoryRuns.conversationId})::int`,
      modes: sql<
        string[]
      >`array_agg(distinct ${aiCategoryRuns.mode} order by ${aiCategoryRuns.mode})`,
      firstMessageAt: min(aiCategoryRuns.messageCreatedAt),
      lastMessageAt: max(aiCategoryRuns.messageCreatedAt),
      lastWrittenAt: max(aiCategoryRuns.createdAt),
    })
    .from(aiCategoryRuns)
    .groupBy(aiCategoryRuns.runLabel, aiCategoryRuns.requestFingerprint)
    .orderBy(desc(max(aiCategoryRuns.createdAt)), asc(aiCategoryRuns.runLabel))
    .limit(50);

  return rows.map((row) => ({
    ...row,
    // `min` and `max` over a group that exists are never null.
    firstMessageAt: row.firstMessageAt!,
    lastMessageAt: row.lastMessageAt!,
    lastWrittenAt: row.lastWrittenAt!,
  }));
}

/**
 * Every figure the page draws for one label and question.
 *
 * Read one after another, not at once: each is one statement, and the page
 * that calls this has its own reads beside it (`allLimited`, §6.91).
 */
export async function categoryAiReport(runLabel: string, fingerprint: string): Promise<Grading> {
  const scope = and(
    eq(aiCategoryRuns.runLabel, runLabel),
    eq(aiCategoryRuns.requestFingerprint, fingerprint),
  );
  const named = db
    .selectDistinct({ id: aiCategoryRuns.conversationId })
    .from(aiCategoryRuns)
    .where(scope);

  const runs = await db
    .select({
      conversationId: aiCategoryRuns.conversationId,
      channel: aiCategoryRuns.channel,
      messageCreatedAt: aiCategoryRuns.messageCreatedAt,
      outcome: aiCategoryRuns.outcome,
      predictedKey: aiCategoryRuns.predictedKey,
      probability: aiCategoryRuns.probability,
      minProbability: aiCategoryRuns.minProbability,
      baselineKey: aiCategoryRuns.baselineCategoryKey,
    })
    .from(aiCategoryRuns)
    .where(scope)
    .orderBy(
      asc(aiCategoryRuns.conversationId),
      asc(aiCategoryRuns.messageCreatedAt),
      asc(aiCategoryRuns.id),
    );

  const events = await db
    .select({
      conversationId: conversationEvents.conversationId,
      createdAt: conversationEvents.createdAt,
      agentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      key: sql<string | null>`${conversationEvents.data}->>'key'`,
      runLabel: sql<string | null>`${conversationEvents.data}->>'runLabel'`,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.type, 'category_changed'),
        inArray(conversationEvents.conversationId, named),
      ),
    )
    // `CHANGE_STAMP` orders two writers the way the column was written; the
    // id only breaks a tie nothing should produce.
    .orderBy(
      asc(conversationEvents.conversationId),
      asc(conversationEvents.createdAt),
      asc(conversationEvents.id),
    );

  const ticketRows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      labellable: sql<boolean>`(${conversations.deletedAt} is null and not ${conversations.isSpam} and ${conversations.mergedIntoId} is null and ${conversations.categoryId} is null)`,
    })
    .from(conversations)
    .where(inArray(conversations.id, named));

  const categories = await listCategories();

  const tickets = new Map<string, GradingTicket>(
    ticketRows.map((row) => [row.id, { number: row.number, labellable: row.labellable }]),
  );

  return grade({
    runLabel,
    runs: runs.map((row) => ({ ...row, outcome: asOutcome(row.outcome) })),
    events,
    tickets,
    categoryKeys: categories.map((category) => category.key),
    thresholds: SWEEP_THRESHOLDS,
  });
}

/**
 * Only the classifier's writers set `outcome`, typed by `CategoryOutcome`, and
 * no CHECK holds the column to the list — so anything else is a row written by
 * hand. Read as `failed`, the one outcome that grades nothing and settles
 * nothing.
 */
function asOutcome(value: string): CategoryOutcome {
  return (CATEGORY_OUTCOMES as readonly string[]).includes(value)
    ? (value as CategoryOutcome)
    : 'failed';
}

/**
 * `classify_category` jobs in `dead`: the one way a message the live
 * classifier was meant to decide about ends with no row, which no other figure
 * on the page can see (`plans/ticket-category-routing.md`, 4.1, as built).
 * Never cleaned up, so the count is every one there has been.
 */
export async function deadClassifyJobs(): Promise<{
  count: number;
  first: Date | null;
  last: Date | null;
}> {
  const [row] = await db
    .select({ count: count(), first: min(jobs.createdAt), last: max(jobs.createdAt) })
    .from(jobs)
    .where(and(eq(jobs.type, 'classify_category'), eq(jobs.status, 'dead')));
  return { count: row?.count ?? 0, first: row?.first ?? null, last: row?.last ?? null };
}
