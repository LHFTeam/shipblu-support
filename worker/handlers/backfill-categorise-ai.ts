import { and, asc, eq, exists, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiCategoryRuns, conversationCategories, conversations, messages } from '@/db/schema';
import { categoryOptionsForAi } from '@/lib/categorise-ai/options';
import { formatReport, reportFor } from '@/lib/categorise-ai/report';
import { runOne, type MessageToRun, type RunSettings } from '@/lib/categorise-ai/run';
import { categorisationRequest } from '@/lib/categorise-ai/request';
import { UNCLASSIFIED_KEY } from '@/lib/categorise/taxonomy';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { scanMessagesInKeysetOrder } from '@/lib/queue/backfill';
import { CONVERSATION_CHANNELS, readOnlyChannels } from '@/lib/tickets/channel-policy';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { typesafeConfigured, typesafeModel } from '@/lib/typesafe/client';
import { logger } from '@/lib/log';

/**
 * Runs the archive through TypeSafe and records what it said, beside the rules.
 *
 * A measurement, not a second detector. Nothing this writes is read by the review
 * queue, the primary ladder or either rollup — see `db/schema/categorise-ai.ts`
 * for why that separation is the design rather than a staging step.
 *
 * Deliberately hand-run and not on a cron. A shadow run is an experiment with a
 * label on it; something that fires nightly would accumulate rows nobody asked
 * for against a model alias that moves underneath it.
 *
 *     npm run job -- backfill_categorise_ai dryRun=true limit=5
 *     npm run job -- backfill_categorise_ai runLabel=smoke limit=5
 *     npm run job -- backfill_categorise_ai runLabel=baseline onlyUnclassified=true
 *     npm run job -- backfill_categorise_ai runLabel=full-2026-09
 *     npm run job -- backfill_categorise_ai runLabel=full-2026-09 reportOnly=true
 *
 * **The bot channel is excluded**, through the same `readOnlyChannels()` the live
 * categoriser uses — its menu is a self-service funnel rather than support demand,
 * and measuring a classifier on it would be measuring the menu. That leaves a
 * corpus of a few hundred messages, which the report says out loud above every
 * figure it prints. `channels=whatsapp_bot` overrides it for anyone who wants the
 * larger validation corpus; that is a decision to take deliberately at a command
 * line, not a default.
 */

/** The run's options, as the schema in `lib/queue/payloads.ts` hands them over. */
type Payload = ReturnType<typeof parseJobPayload<'backfill_categorise_ai'>>;

const BATCH = 200;

/**
 * How many earlier messages ride along as context.
 *
 * Three rather than the whole thread. These messages average 22 to 39 characters,
 * so three of them is a couple of lines and costs almost nothing; the whole thread
 * would let a long ticket's opening complaint dominate the classification of a
 * later "ok thanks", which is a different message about a different thing.
 */
const CONTEXT_MESSAGES = 3;

const TAG = '[backfill_categorise_ai]';
const log = logger('backfill_categorise_ai');

export async function backfillCategoriseAi(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'backfill_categorise_ai');
  const runLabel = payload.runLabel ?? 'adhoc';
  const dryRun = payload.dryRun === true;
  const withContext = payload.context !== false;

  if (payload.reportOnly === true) {
    console.log(formatReport(await reportFor(runLabel)));
    return;
  }

  if (!dryRun && !typesafeConfigured()) {
    // Unset means skip rather than fail, the same answer the Freshdesk importer
    // gives: this is a credential nobody has had to hold yet, and a hand-run that
    // throws teaches less than one that says what is missing.
    log.info(`TYPESAFE_API_KEY is not set — nothing to run`);
    return;
  }

  const options = await categoryOptionsForAi();
  if (options.length === 0 && !dryRun) {
    // An empty registry is a database nobody has seeded, not a bug here.
    //
    // A dry run deliberately carries on past this. Its whole job is to put the
    // selection and report queries in front of a real Postgres — that is why it
    // is in CI's handler loop — and CI's database has migrations but no seeded
    // taxonomy, so bailing out here would skip exactly the SQL it is there to
    // prove. `tsc` type-checks the drizzle builder, not the statement it emits.
    log.info(`no active detectable categories in ticket_categories — nothing to ask`);
    console.log(formatReport(await reportFor(runLabel)));
    return;
  }

  const settings: RunSettings = {
    runLabel,
    model: typesafeModel(),
    withContext,
    options,
    offered: new Set(options.map((option) => option.key)),
  };

  const where = await candidateFilter(payload, runLabel);

  let predicted = 0;
  let failed = 0;

  const scanned = await scanMessagesInKeysetOrder(
    { batchSize: BATCH, limit: payload.limit },
    (after, size) =>
      db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          bodyText: messages.bodyText,
          createdAt: messages.createdAt,
          channel: conversations.channel,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(...where, after))
        .orderBy(asc(messages.id))
        .limit(size),
    async (row) => {
      if (!row.bodyText.trim()) return;

      const message: MessageToRun = {
        conversationId: row.conversationId,
        messageId: row.id,
        channel: row.channel,
        bodyText: row.bodyText,
        earlier: withContext ? await earlierMessages(row.conversationId, row.createdAt) : [],
      };

      if (dryRun) {
        // Build the body and throw it away. Cheap, and it means a question this
        // system can no longer construct — a taxonomy past the 255-option limit
        // — fails here rather than on a live run. Skipped on an empty registry,
        // which `categoryQuestion` refuses by design and which says nothing about
        // the queries this run is here to exercise.
        if (settings.options.length > 0) {
          categorisationRequest(message, settings.options, settings.model, settings.withContext);
        }
        return;
      }

      const result = await runOne(message, settings);
      if (result.outcome === 'predicted') predicted += 1;
      else failed += 1;
    },
  );

  log.info(
    `run="${runLabel}" scanned=${scanned} predicted=${predicted} failed=${failed} ` +
      `context=${withContext} dry_run=${dryRun}`,
  );
  console.log(formatReport(await reportFor(runLabel)));

  if (failed > 0) {
    // Thrown after everything durable is written, so the queue's retry only fills
    // the gaps: the rows that succeeded are not selected again, and the ones
    // carrying an error are the only ones the upsert will replace.
    throw new Error(`${TAG} ${failed} message(s) failed transiently; re-run to fill the gaps`);
  }
}

/** Which messages are in scope, as one list of predicates. */
async function candidateFilter(payload: Payload, runLabel: string): Promise<SQL[]> {
  const where: SQL[] = [
    eq(messages.kind, 'reply'),
    eq(messages.direction, 'inbound'),
    sql`btrim(${messages.bodyText}) <> ''`,
  ];

  const channels = requestedChannels(payload.channels);
  if (channels) where.push(inArray(conversations.channel, channels));
  else where.push(notInArray(conversations.channel, readOnlyChannels()));

  if (payload.since) where.push(gte(messages.createdAt, new Date(payload.since)));
  if (payload.until) where.push(lte(messages.createdAt, new Date(payload.until)));

  if (payload.onlyUnclassified === true) {
    where.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(conversationCategories)
          .where(
            and(
              eq(conversationCategories.conversationId, conversations.id),
              eq(conversationCategories.categoryKey, UNCLASSIFIED_KEY),
            ),
          ),
      ),
    );
  }

  // Already measured under this label, successfully. A row carrying an error is
  // deliberately not excluded — re-running a label is how a rate-limited run is
  // completed, and that is the only thing it may change.
  where.push(
    sql`not ${exists(
      db
        .select({ one: sql`1` })
        .from(aiCategoryRuns)
        .where(
          and(
            eq(aiCategoryRuns.runLabel, runLabel),
            eq(aiCategoryRuns.messageId, messages.id),
            isNull(aiCategoryRuns.error),
          ),
        ),
    )}`,
  );

  return where;
}

/**
 * A typo in `channels=` is an error, not an empty run.
 *
 * Checked against the channel list rather than passed through, because
 * `inArray` on a value the enum does not contain returns nothing at all — and a
 * run that measured zero messages and a run whose filter was misspelt print the
 * same thing.
 */
function requestedChannels(raw: string | undefined): ConversationChannel[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  const channels: ConversationChannel[] = [];
  for (const name of names) {
    const match = CONVERSATION_CHANNELS.find((channel) => channel === name);
    if (!match) throw new Error(`${TAG} "${name}" is not a conversation channel`);
    channels.push(match);
  }

  return channels.length > 0 ? channels : null;
}

/** The inbound messages just before this one, oldest first. */
async function earlierMessages(conversationId: string, before: Date): Promise<string[]> {
  const rows = await db
    .select({ bodyText: messages.bodyText })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.kind, 'reply'),
        eq(messages.direction, 'inbound'),
        sql`${messages.createdAt} < ${before.toISOString()}::timestamptz`,
        sql`btrim(${messages.bodyText}) <> ''`,
      ),
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(CONTEXT_MESSAGES);

  return rows.map((row) => row.bodyText).reverse();
}
