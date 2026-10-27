import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  max,
  min,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/db/client';
import {
  CATEGORY_AI_LIVE_LABEL,
  aiCategoryRuns,
  conversationEvents,
  conversations,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { listCategories } from '@/lib/categories/queries';
import { CATEGORY_OUTCOMES, type CategoryOutcome } from './decide';
import { grade, type Grading, type GradingTicket } from './grade';
import { jevMayStillAsk } from './runs';

/**
 * The reads behind `/reports/category-ai`: which run labels and questions
 * there are to choose from, and, for the one chosen, every row, every
 * `category_changed` on the tickets they name, and those tickets' numbers.
 * `grade.ts` does the judging, so nothing here decides what counts.
 *
 * One label, one question and one mode at a time
 * (`plans/ticket-category-routing.md`, 4.2): a label holds the answers one run
 * gave, and a question edited on `/admin/categories` is a different question,
 * which no figure may average with the one before it. The mode splits the live
 * label at the switch to `apply`: a shadow answer settles a ticket that apply
 * then asks about again, and graded together the shadow's key would be graded
 * against a ticket apply filed under another.
 *
 * Read whole rather than counted in SQL. A label is at most every customer
 * message since the archive starts — tens of thousands of narrow rows — and the
 * grading walks each ticket's rows in order, which is a loop in code and a
 * window function nobody could review in SQL.
 */

/** Thresholds every sweep shows; the ones in force are added to them. */
const SWEEP_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** One label, question and mode to choose from, newest first. */
export type RunQuestion = {
  runLabel: string;
  fingerprint: string;
  mode: string;
  rows: number;
  tickets: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
  lastWrittenAt: Date;
};

export async function runQuestions(): Promise<RunQuestion[]> {
  return questionsWhere(undefined);
}

/**
 * One run by its label, question and mode, for a link to a run the list
 * above has dropped past its limit. Null when it holds no rows.
 */
export async function runQuestion(
  runLabel: string,
  fingerprint: string,
  mode: string,
): Promise<RunQuestion | null> {
  const [question] = await questionsWhere(
    and(
      eq(aiCategoryRuns.runLabel, runLabel),
      eq(aiCategoryRuns.requestFingerprint, fingerprint),
      eq(aiCategoryRuns.mode, mode),
    ),
  );
  return question ?? null;
}

async function questionsWhere(where: SQL | undefined): Promise<RunQuestion[]> {
  const rows = await db
    .select({
      runLabel: aiCategoryRuns.runLabel,
      fingerprint: aiCategoryRuns.requestFingerprint,
      rows: count(),
      mode: aiCategoryRuns.mode,
      tickets: sql<number>`count(distinct ${aiCategoryRuns.conversationId})::int`,
      firstMessageAt: min(aiCategoryRuns.messageCreatedAt),
      lastMessageAt: max(aiCategoryRuns.messageCreatedAt),
      lastWrittenAt: max(aiCategoryRuns.createdAt),
    })
    .from(aiCategoryRuns)
    .where(where)
    .groupBy(aiCategoryRuns.runLabel, aiCategoryRuns.requestFingerprint, aiCategoryRuns.mode)
    .orderBy(desc(max(aiCategoryRuns.createdAt)), asc(aiCategoryRuns.runLabel))
    // Every run there has been, as far as anybody will page: a label is made
    // by hand, a question by an admin's edit, a mode by the switch.
    .limit(200);

  return rows.map((row) => ({
    ...row,
    // `min` and `max` over a group that exists are never null.
    firstMessageAt: row.firstMessageAt!,
    lastMessageAt: row.lastMessageAt!,
    lastWrittenAt: row.lastWrittenAt!,
  }));
}

/**
 * Every figure the page draws for one label, question and mode.
 *
 * Read one after another, not at once: each is one statement, and the page
 * that calls this has its own reads beside it (`allLimited`, §6.91).
 */
export async function categoryAiReport(
  runLabel: string,
  fingerprint: string,
  mode: string,
): Promise<Grading> {
  const scope = and(
    eq(aiCategoryRuns.runLabel, runLabel),
    eq(aiCategoryRuns.requestFingerprint, fingerprint),
    eq(aiCategoryRuns.mode, mode),
  );
  const named = db
    .selectDistinct({ id: aiCategoryRuns.conversationId })
    .from(aiCategoryRuns)
    .where(scope);

  const runs = await db
    .select({
      conversationId: aiCategoryRuns.conversationId,
      messageId: aiCategoryRuns.messageId,
      channel: aiCategoryRuns.channel,
      messageCreatedAt: aiCategoryRuns.messageCreatedAt,
      outcome: aiCategoryRuns.outcome,
      predictedKey: aiCategoryRuns.predictedKey,
      probability: aiCategoryRuns.probability,
      minProbability: aiCategoryRuns.minProbability,
      baselineKey: aiCategoryRuns.baselineCategoryKey,
      writtenAt: aiCategoryRuns.createdAt,
    })
    .from(aiCategoryRuns)
    .where(scope)
    // Grouped by ticket in `grade`, which orders each ticket's rows the way the
    // live job and the backfill judge them, stably: the row id settles the
    // one tie that has no order, two deleted messages of the same instant, the
    // same way on every load.
    .orderBy(
      asc(aiCategoryRuns.conversationId),
      asc(aiCategoryRuns.messageCreatedAt),
      asc(aiCategoryRuns.id),
    );

  // The label's answers in its other views, which the live job's cap counted
  // with these: a ticket asked four times in shadow had one ask left in apply.
  const askedElsewhere = await db
    .select({
      conversationId: aiCategoryRuns.conversationId,
      messageId: aiCategoryRuns.messageId,
      messageCreatedAt: aiCategoryRuns.messageCreatedAt,
    })
    .from(aiCategoryRuns)
    .where(
      and(
        eq(aiCategoryRuns.runLabel, runLabel),
        or(ne(aiCategoryRuns.requestFingerprint, fingerprint), ne(aiCategoryRuns.mode, mode)),
        isNotNull(aiCategoryRuns.predictedKey),
        ne(aiCategoryRuns.outcome, 'failed'),
        inArray(aiCategoryRuns.conversationId, named),
      ),
    );

  const events = await db
    .select({
      conversationId: conversationEvents.conversationId,
      createdAt: conversationEvents.createdAt,
      agentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      key: sql<string | null>`${conversationEvents.data}->>'key'`,
      runLabel: sql<string | null>`${conversationEvents.data}->>'runLabel'`,
      messageId: sql<string | null>`${conversationEvents.data}->>'messageId'`,
      messageCreatedAt: sql<string | null>`${conversationEvents.data}->>'messageCreatedAt'`,
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
      categoryId: conversations.categoryId,
      deletedAt: conversations.deletedAt,
      isSpam: conversations.isSpam,
      mergedIntoId: conversations.mergedIntoId,
      sourceSystem: conversations.sourceSystem,
      firstRespondedAt: conversations.firstRespondedAt,
      // A plain join: this read takes no lock, so nothing re-checks it.
      statusCategory: ticketStatuses.category,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(inArray(conversations.id, named));

  const categories = await listCategories();

  const tickets = new Map<string, GradingTicket>(
    ticketRows.map((row) => [
      row.id,
      {
        number: row.number,
        labellable:
          row.deletedAt === null &&
          !row.isSpam &&
          row.mergedIntoId === null &&
          row.categoryId === null,
        windowOpen: jevMayStillAsk(row),
      },
    ]),
  );
  const answeredAt = new Map(ticketRows.map((row) => [row.id, row.firstRespondedAt]));
  const live = runLabel === CATEGORY_AI_LIVE_LABEL;

  return grade({
    runLabel,
    runs: runs.map(({ writtenAt, ...row }) => {
      const answered = answeredAt.get(row.conversationId) ?? null;
      // The live job judges a message when its job runs; a backfill as of
      // when the message arrived.
      const judgedAt = live ? writtenAt : row.messageCreatedAt;
      return {
        ...row,
        outcome: asOutcome(row.outcome),
        judgedAfterReply: answered !== null && judgedAt >= answered,
      };
    }),
    askedElsewhere,
    events: events.map((event) => ({
      ...event,
      messageCreatedAt: instantOf(event.messageCreatedAt),
    })),
    tickets,
    // The categories a question can offer: a retired one Jev answered or a
    // person chose is added back by `grade`, from the rows.
    categoryKeys: categories
      .filter((category) => category.isActive)
      .map((category) => category.key),
    thresholds: SWEEP_THRESHOLDS,
  });
}

/**
 * An instant a Jev write recorded as text. Only the classifier's writers set
 * it, always as ISO, but read in code rather than cast in SQL: one hand-edited
 * event would otherwise refuse the whole page.
 */
function instantOf(text: string | null): Date | null {
  if (text === null) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
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
 * `classify_category` jobs in `dead` whose message is still there with no
 * live row: the one way a message the live classifier was meant to decide
 * about ends with none, which no other figure on the page can see
 * (`plans/ticket-category-routing.md`, 4.1, as built). Dead jobs are never
 * cleaned up, and a purge keeps them as history, so the count would otherwise
 * be every one there has been. A message a run by hand has since given a row
 * leaves it, whether the row answered or failed: a failure is a row like any
 * other, and the footer counts it where nothing else on the ticket was judged.
 * A message purged since leaves it too, and nothing could answer it now.
 *
 * The payload's id is compared only once it reads as a uuid: a job that died
 * because its payload failed its schema holds whatever was written, and a
 * cast of that would refuse the whole page. Such a job names no message to
 * look for, and stays in the count.
 */
export async function deadClassifyJobs(): Promise<{
  count: number;
  first: Date | null;
  last: Date | null;
}> {
  const messageId = sql`case when ${jobs.payload}->>'messageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${jobs.payload}->>'messageId')::uuid end`;
  const [row] = await db
    .select({ count: count(), first: min(jobs.createdAt), last: max(jobs.createdAt) })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'classify_category'),
        eq(jobs.status, 'dead'),
        or(
          sql`${messageId} is null`,
          and(
            exists(
              db
                .select({ one: sql`1` })
                .from(messages)
                .where(eq(messages.id, messageId)),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(aiCategoryRuns)
                .where(
                  and(
                    eq(aiCategoryRuns.messageId, messageId),
                    eq(aiCategoryRuns.runLabel, CATEGORY_AI_LIVE_LABEL),
                  ),
                ),
            ),
          ),
        ),
      ),
    );
  return { count: row?.count ?? 0, first: row?.first ?? null, last: row?.last ?? null };
}
