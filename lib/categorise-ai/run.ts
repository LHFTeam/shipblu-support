import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiCategoryRuns } from '@/db/schema';
import { bandFor, detectCategories } from '@/lib/categorise/detect';
import { TypeSafeApiError, choiceAnswer, systemOne } from '@/lib/typesafe/client';
import { predictionFrom } from './map';
import { CATEGORY_QUESTION, categorisationRequest, type CategoryOption } from './request';

/**
 * One message, asked of TypeSafe and recorded beside what the rules said.
 *
 * The rules baseline is computed here, in the same call, from the same string —
 * not read back from `conversation_categories`. Those rows may since have been
 * confirmed, rejected or added by an agent, so comparing against them would
 * measure how the team has been curating the queue rather than how the detector
 * performs. `detectCategories` is pure and touches no database, so asking it
 * again costs nothing and is the only version of the baseline that is about the
 * detector.
 */

export type MessageToRun = {
  conversationId: string;
  messageId: string;
  channel: string;
  bodyText: string;
  /** Earlier inbound messages on the ticket, oldest first. */
  earlier: readonly string[];
};

export type RunSettings = {
  runLabel: string;
  model: string;
  withContext: boolean;
  options: readonly CategoryOption[];
  /** The option keys, once, rather than rebuilt per message. */
  offered: ReadonlySet<string>;
  timeoutMs?: number;
};

export type RunOutcome = 'predicted' | 'failed';

/**
 * What the rules detector would have written for this text.
 *
 * `bandFor` filtering matches `apply.ts`: a hit below the record threshold is not
 * something the rules would have stored, so counting it here would credit them
 * with work they do not do. The fallback survives that filter by design and is
 * why a message the rules cannot read shows as `meta.unclassified` rather than as
 * an empty array — which is the distinction the whole comparison turns on.
 */
function rulesBaseline(bodyText: string): { keys: string[]; topConfidence: number | null } {
  const hits = detectCategories({ bodyText }).filter((hit) => bandFor(hit) !== 'ignored');
  if (hits.length === 0) return { keys: [], topConfidence: null };
  return {
    keys: hits.map((hit) => hit.key),
    topConfidence: Math.max(...hits.map((hit) => hit.confidence)),
  };
}

/**
 * Ask, then record — including when the asking failed.
 *
 * A transient failure is written as a row carrying `error` and reported back, so
 * the handler can finish the corpus and throw once at the end rather than
 * abandoning 600 good measurements over one 429. A permanent failure is rethrown
 * untouched: a 401, a malformed question or an answer naming a category nobody
 * offered is wrong for every message in the run, and writing 640 identical error
 * rows would bury that under its own output.
 */
export async function runOne(
  message: MessageToRun,
  settings: RunSettings,
): Promise<{ outcome: RunOutcome; inputTokens: number | null }> {
  const rules = rulesBaseline(message.bodyText);
  const request = categorisationRequest(
    message,
    settings.options,
    settings.model,
    settings.withContext,
  );

  const startedAt = Date.now();
  try {
    const response = await systemOne(request, { timeoutMs: settings.timeoutMs });
    const prediction = predictionFrom(choiceAnswer(response, CATEGORY_QUESTION), settings.offered);

    await write(message, settings, {
      model: response.model,
      predictedKey: prediction.key,
      probability: prediction.probability,
      confidence: prediction.confidence,
      probabilities: prediction.probabilities,
      inputTokens: response.inputTokens,
      latencyMs: Date.now() - startedAt,
      error: null,
      rules,
    });

    return { outcome: 'predicted', inputTokens: response.inputTokens };
  } catch (error) {
    if (error instanceof TypeSafeApiError && !error.isTransient) throw error;

    await write(message, settings, {
      model: null,
      predictedKey: null,
      probability: null,
      confidence: null,
      probabilities: {},
      inputTokens: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      rules,
    });

    return { outcome: 'failed', inputTokens: null };
  }
}

type WriteFields = {
  model: string | null;
  predictedKey: string | null;
  probability: number | null;
  confidence: number | null;
  probabilities: Record<string, number>;
  inputTokens: number | null;
  latencyMs: number;
  error: string | null;
  rules: { keys: string[]; topConfidence: number | null };
};

/**
 * Insert, or replace a row that failed last time.
 *
 * `setWhere` is the whole of the idempotency argument. A re-run after a rate
 * limit must fill the gaps it left, so a row carrying `error` is replaceable; a
 * row carrying a measurement must not be, or re-running a label would silently
 * re-date results somebody has already drawn a conclusion from. Measure it again
 * under a new `runLabel` instead — which is what the label is for.
 */
async function write(
  message: MessageToRun,
  settings: RunSettings,
  fields: WriteFields,
): Promise<void> {
  const values = {
    conversationId: message.conversationId,
    messageId: message.messageId,
    runLabel: settings.runLabel,
    model: fields.model,
    withContext: settings.withContext,
    predictedKey: fields.predictedKey,
    probability: fields.probability,
    confidence: fields.confidence,
    probabilities: fields.probabilities,
    rulesKeys: fields.rules.keys,
    rulesTopConfidence: fields.rules.topConfidence,
    inputTokens: fields.inputTokens,
    latencyMs: fields.latencyMs,
    error: fields.error,
  };

  await db
    .insert(aiCategoryRuns)
    .values(values)
    .onConflictDoUpdate({
      target: [aiCategoryRuns.runLabel, aiCategoryRuns.messageId],
      set: values,
      setWhere: sql`${aiCategoryRuns.error} is not null`,
    });
}
