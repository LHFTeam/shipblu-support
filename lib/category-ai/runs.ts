import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiCategoryRuns, conversationShipments, conversations, messages } from '@/db/schema';
import { predictionFrom, type AiPrediction } from '@/lib/subcategorise-ai/map';
import {
  choiceAnswer,
  systemOne,
  type SystemOneRequest,
  type SystemOneResponse,
} from '@/lib/typesafe/client';
import { CATEGORY_QUESTION } from './request';

/**
 * What the live classifier (`run.ts`) and the backfill (`backfill.ts`) share:
 * the message as both load it, why the category classifier passes one over,
 * the call, and the run row — so a backfill row and a live row for the same
 * message differ only in what each was told to judge it as of.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Tx;

/**
 * The columns a message is judged by, off the message and its ticket: what
 * `skipReason` reads, what the request sends, and what the run row records.
 * `hasShipment` is whether a shipment is linked now; the backfill reads its
 * own, as of each message.
 */
export const classifiableColumns = {
  messageId: messages.id,
  conversationId: messages.conversationId,
  kind: messages.kind,
  direction: messages.direction,
  bodyText: messages.bodyText,
  createdAt: messages.createdAt,
  meta: messages.meta,
  authorContactId: messages.authorContactId,
  requesterContactId: conversations.requesterContactId,
  channel: conversations.channel,
  channelId: conversations.channelId,
  externalId: conversations.externalId,
  sourceSystem: conversations.sourceSystem,
  mergedIntoId: conversations.mergedIntoId,
  requesterKind: conversations.requesterKind,
  isSpam: conversations.isSpam,
  deletedAt: conversations.deletedAt,
  firstRespondedAt: conversations.firstRespondedAt,
  hasShipment: sql<boolean>`exists (select 1 from ${conversationShipments} where ${conversationShipments.conversationId} = ${conversations.id})`,
};

/**
 * Why this message is not one for the category classifier, beyond the shared
 * `skipReason` — kept out of that one so priority asks about exactly what it
 * asked about before.
 *
 * A copied WhatsApp history is a record, not traffic (`AGENTS.md`), and a
 * merged ticket is answered on the ticket it was merged into; neither is
 * routed, so neither is asked about. No enqueue path reaches either today —
 * this is for a job run by hand, and for the backfill.
 */
export function categorySkipReason(row: { sourceSystem: string; mergedIntoId: string | null }) {
  if (row.sourceSystem === 'import') return 'imported history';
  if (row.mergedIntoId) return 'merged';
  return null;
}

/**
 * Why a ticket is in nobody's queue, so not one Jev files: deleted, spam,
 * merged into another, or resolved or closed — work that is over, where
 * filing it would only run the rules keyed on its category against a ticket
 * nobody is routing. The live job asks it before and after its call, and the
 * backfill's apply mode before filing, so the two never disagree about which
 * tickets Jev may write to.
 */
export function queueRefusal(ticket: {
  deletedAt: Date | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  statusCategory: string;
}): string | null {
  if (ticket.deletedAt) return 'deleted';
  if (ticket.isSpam) return 'spam';
  if (ticket.mergedIntoId) return 'merged';
  if (ticket.statusCategory !== 'open' && ticket.statusCategory !== 'pending') {
    return 'resolved or closed';
  }
  return null;
}

/**
 * Whether the live job may still ask about the ticket's next message: in
 * somebody's queue (`queueRefusal`), not a record the job never asks about
 * (`categorySkipReason`), and not yet answered, which caps it
 * (`ticketFacts`). The report's labelling list asks it rather than its own
 * reading of the same rules, so the two cannot drift apart.
 */
export function jevMayStillAsk(ticket: {
  deletedAt: Date | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  statusCategory: string;
  sourceSystem: string;
  firstRespondedAt: Date | null;
}): boolean {
  return (
    queueRefusal(ticket) === null &&
    categorySkipReason(ticket) === null &&
    ticket.firstRespondedAt === null
  );
}

/**
 * One question to Jev and its answer, read against the keys it was offered.
 * Throws what the client throws; the caller decides what a failure means for
 * its run.
 */
export async function askJev(
  request: SystemOneRequest,
  offered: ReadonlySet<string>,
  options: { baseUrl?: string; timeoutMs?: number },
): Promise<{ response: SystemOneResponse; prediction: AiPrediction; latencyMs: number }> {
  const startedAt = Date.now();
  const response = await systemOne(request, options);
  const prediction = predictionFrom(choiceAnswer(response, CATEGORY_QUESTION), offered);
  return { response, prediction, latencyMs: Date.now() - startedAt };
}

/** A row as written: `created_at` may be `CHANGE_STAMP`, which drizzle sends as SQL. */
export type RunRow = Omit<typeof aiCategoryRuns.$inferInsert, 'createdAt'> & {
  createdAt?: Date | SQL;
};

/**
 * Every column a run sets, as a row that asked nothing: what an answer leaves
 * unsaid, so the row it replaces cannot say it instead.
 */
const UNANSWERED = {
  model: null,
  withContext: false,
  predictedKey: null,
  probability: null,
  confidence: null,
  probabilities: {},
  minProbability: null,
  categoryKeyBefore: null,
  baselineCategoryKey: null,
  baselineSubcategoryKeys: [],
  channelId: null,
  hasShipment: false,
  requesterKind: null,
  inputTokens: null,
  latencyMs: null,
  error: null,
} satisfies Partial<RunRow>;

/**
 * One run row, or none when this message already has a real answer under its
 * label: only a `failed` row gives way, to the first answer that is not one.
 *
 * Replaced whole. An answer known before asking — capped, after a settle —
 * sets no prediction, and merged over the failure it replaces it kept the
 * failure's error, which the table refuses beside any other outcome, and the
 * prediction a retired category had refused, which the cap would then count.
 */
export async function insertRun(executor: Executor, run: RunRow): Promise<boolean> {
  const row = { ...UNANSWERED, ...run };
  const inserted = await executor
    .insert(aiCategoryRuns)
    .values(row)
    .onConflictDoUpdate({
      target: [aiCategoryRuns.messageId, aiCategoryRuns.runLabel],
      set: row,
      setWhere: eq(aiCategoryRuns.outcome, 'failed'),
    })
    .returning({ id: aiCategoryRuns.id });
  return inserted.length > 0;
}

/** A permanent refusal, recorded once; a later run by hand replaces it. */
export async function recordFailure(
  run: Omit<RunRow, 'outcome'> & { error: string },
): Promise<void> {
  await db
    .insert(aiCategoryRuns)
    .values({ ...run, outcome: 'failed' })
    .onConflictDoNothing({ target: [aiCategoryRuns.messageId, aiCategoryRuns.runLabel] });
}
