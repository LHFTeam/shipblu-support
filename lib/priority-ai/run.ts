import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  aiPriorityRuns,
  conversationEvents,
  conversations,
  messages,
  ticketForms,
} from '@/db/schema';
import { isCategorisableMessage } from '@/lib/categorise/apply';
import { earlierMessages } from '@/lib/categorise-ai/context';
import { predictionFrom, type AiPrediction } from '@/lib/categorise-ai/map';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';
import { onPriorityChanged } from '@/lib/sla';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { PRIORITIES, isPriority, type Priority } from '@/lib/tickets/vocabulary';
import {
  TypeSafeApiError,
  choiceAnswer,
  type SystemOneResponse,
  systemOne,
  typesafeConfigured,
  typesafeModel,
} from '@/lib/typesafe/client';
import { CONFIDENT_OUTCOMES, decide, type PriorityOutcome } from './decide';
import { PRIORITY_QUESTION, priorityRequest } from './request';
import { priorityAiMinProbability, priorityAiMode, type PriorityAiMode } from './settings';

const log = logger('classify_priority');

/**
 * One inbound message, asked of Jev, recorded, and — when the answer is
 * confident and nobody else owns the ticket's priority — written.
 *
 * Everything the enqueue side checked is checked again here, because the job can
 * run minutes later, after a retry, or after the switch was turned off; and
 * because a job row is something anybody with `npm run job` can write.
 */

/**
 * Who the timeline names for a change this module makes.
 *
 * In the `automation:<rule>` shape the timeline already renders raw, so the
 * console needs no new branch to show it — and stable, so `decide.ts` can tell
 * the classifier's own earlier writes from everybody else's. Not the model name:
 * that is on the run row, and it changes.
 */
export const PRIORITY_AI_ACTOR = 'jev:priority';

/** Every level, once, for `predictionFrom` to check the answer against. */
const OFFERED: ReadonlySet<string> = new Set(PRIORITIES);

export type ClassifyResult =
  | { status: 'gone' }
  | { status: 'skipped'; reason: string }
  | { status: 'already_classified' }
  | { status: 'recorded'; outcome: PriorityOutcome; predicted: Priority | null };

export type ClassifyOptions = {
  /** Overridden by tests and by nothing else. */
  baseUrl?: string;
  timeoutMs?: number;
};

export async function classifyMessagePriority(
  messageId: string,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const mode = priorityAiMode();
  if (mode === 'off') return { status: 'skipped', reason: 'PRIORITY_AI is off' };
  if (!typesafeConfigured()) return { status: 'skipped', reason: 'TYPESAFE_API_KEY is not set' };

  const [row] = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      kind: messages.kind,
      direction: messages.direction,
      bodyText: messages.bodyText,
      createdAt: messages.createdAt,
      meta: messages.meta,
      channel: conversations.channel,
      isSpam: conversations.isSpam,
      deletedAt: conversations.deletedAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!row) return { status: 'gone' };

  const skip = skipReason(row);
  if (skip) return { status: 'skipped', reason: skip };

  // A redelivered job — the worker died after committing — finds its own row
  // and stops, rather than paying for a second answer it could not record.
  const [existing] = await db
    .select({ id: aiPriorityRuns.id })
    .from(aiPriorityRuns)
    .where(eq(aiPriorityRuns.messageId, messageId))
    .limit(1);
  if (existing) return { status: 'already_classified' };

  const withContext = true;
  const request = priorityRequest(
    {
      channel: row.channel,
      bodyText: row.bodyText,
      earlier: await earlierMessages(row.conversationId, row.createdAt),
    },
    typesafeModel(),
    withContext,
  );

  const startedAt = Date.now();
  let response: SystemOneResponse;
  let prediction: AiPrediction;
  try {
    response = await systemOne(request, options);
    prediction = predictionFrom(choiceAnswer(response, PRIORITY_QUESTION), OFFERED);
  } catch (error) {
    // Transient — a 429, a 5xx, a timeout — goes back to the queue, whose
    // backoff is the retry policy (`lib/typesafe/client.ts` says why nothing
    // retries in there). Nothing is recorded: the next attempt may well answer,
    // and a job that dies after five is its own record.
    if (!(error instanceof TypeSafeApiError) || error.isTransient) throw error;

    // Permanent — a wrong key, a malformed question, an answer naming a level
    // nobody offered — is recorded and not retried. The ticket keeps its
    // priority, which is the answer a classifier that could not be asked gives.
    log.error(`could not classify message ${messageId}`, error);
    await recordFailure(row.conversationId, messageId, mode, withContext, error);
    return { status: 'recorded', outcome: 'failed', predicted: null };
  }

  // `predictionFrom` has already refused anything outside `OFFERED`, which is
  // `PRIORITIES`; this narrows the type rather than guarding a path.
  if (!isPriority(prediction.key)) {
    throw new TypeSafeApiError(`TypeSafe chose "${prediction.key}"`, null, false);
  }
  const predicted = prediction.key;

  const runFields = {
    conversationId: row.conversationId,
    messageId,
    mode,
    model: response.model,
    withContext,
    predicted,
    probability: prediction.probability,
    confidence: prediction.confidence,
    probabilities: prediction.probabilities,
    inputTokens: response.inputTokens,
    latencyMs: Date.now() - startedAt,
    error: null,
  };

  // Decided and written in one transaction, with the ticket row locked, so an
  // agent's change cannot land between reading the priority and writing over it.
  // The lock is held for a handful of indexed reads — the provider call is
  // already over — and it is the same row an agent's priority change locks.
  const outcome = await db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({ priority: conversations.priority, formId: conversations.formId })
      .from(conversations)
      .where(eq(conversations.id, row.conversationId))
      .for('update')
      .limit(1);
    if (!ticket) return null;

    const facts = await priorityFacts(tx, row.conversationId, ticket.formId, messageId);
    const decision = decide({
      mode,
      predicted,
      probability: prediction.probability,
      minProbability: priorityAiMinProbability(),
      current: ticket.priority,
      lastApplied: facts.lastApplied,
      ownedElsewhere: facts.ownedElsewhere,
      firstConfident: facts.firstConfident,
    });

    // The run row first. Two deliveries of one job racing past the check above
    // are already serialised by the row lock — the second reads the first's
    // write and decides it unchanged — but its own answer has nowhere to go:
    // one row per message is the table's promise. So the unique index settles
    // which delivery's answer is the record, and the loser writes nothing
    // further and reports nothing it did not record.
    const inserted = await tx
      .insert(aiPriorityRuns)
      .values({ ...runFields, priorityBefore: ticket.priority, outcome: decision.outcome })
      .onConflictDoNothing({ target: aiPriorityRuns.messageId })
      .returning({ id: aiPriorityRuns.id });
    if (inserted.length === 0) return 'duplicate';

    if (decision.to) {
      await tx
        .update(conversations)
        .set({ priority: decision.to })
        .where(eq(conversations.id, row.conversationId));
      await tx.insert(conversationEvents).values({
        conversationId: row.conversationId,
        type: 'priority_changed',
        actorLabel: PRIORITY_AI_ACTOR,
        data: {
          to: decision.to,
          from: ticket.priority,
          probability: prediction.probability,
          model: response.model,
          messageId,
        },
      });
    }

    return decision.outcome;
  });

  // A ticket deleted between the two reads cascades its run rows with it, so
  // there is nothing to record and nothing to tell anybody.
  if (outcome === null) return { status: 'gone' };
  if (outcome === 'duplicate') return { status: 'already_classified' };

  if (outcome === 'applied') {
    log.info('applied', {
      messageId,
      conversationId: row.conversationId,
      to: predicted,
      probability: prediction.probability,
    });
    // After the commit, and best-effort inside: an SLA that cannot be
    // re-timed leaves the ticket with its old due date, which is what every
    // priority change did before this, rather than failing a classification
    // already written.
    await onPriorityChanged(row.conversationId);
  }

  return { status: 'recorded', outcome, predicted };
}

type LoadedRow = {
  kind: string;
  direction: string;
  bodyText: string;
  meta: unknown;
  channel: string;
  isSpam: boolean;
  deletedAt: Date | null;
};

/**
 * Why this message is not one to classify, or null if it is.
 *
 * The categoriser's own test for "a customer wrote something", so the two
 * questions are asked of the same messages; the bot channel through
 * `isReadOnlyChannel`, since nobody on the team works it and it is nearly all of
 * the volume. An autoresponder is not the customer — the email ingest flags it
 * and keeps its time off the customer's clock — and a spam or deleted ticket is
 * not in anybody's queue.
 */
function skipReason(row: LoadedRow): string | null {
  if (!isCategorisableMessage(row.kind, row.direction)) return 'not an inbound reply';
  if (!row.bodyText.trim()) return 'no text';
  if (isReadOnlyChannel(row.channel)) return `read-only channel ${row.channel}`;
  if (row.isSpam) return 'spam';
  if (row.deletedAt) return 'deleted';
  if (isAutoReply(row.meta)) return 'an autoresponder';
  return null;
}

function isAutoReply(meta: unknown): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as Record<string, unknown>).isAutoReply === true
  );
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What the ticket's history says about who owns its priority.
 *
 * Read inside the transaction that holds the ticket row, so the answer cannot be
 * stale by the time it is acted on.
 */
async function priorityFacts(
  tx: Tx,
  conversationId: string,
  formId: string | null,
  messageId: string,
): Promise<{ ownedElsewhere: boolean; lastApplied: Priority | null; firstConfident: boolean }> {
  const events = await tx
    .select({
      type: conversationEvents.type,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ['priority_changed', 'opened_by_agent']),
      ),
    )
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));

  let ownedElsewhere = false;
  let lastApplied: Priority | null = null;
  for (const event of events) {
    // An agent who opened the ticket on the customer's behalf chose its priority
    // on the new-ticket form, and that choice writes no `priority_changed`.
    if (event.type === 'opened_by_agent') {
      ownedElsewhere = true;
      continue;
    }
    if (event.actorLabel !== PRIORITY_AI_ACTOR) {
      ownedElsewhere = true;
      continue;
    }
    const to = (event.data as Record<string, unknown> | null)?.to;
    if (isPriority(to)) lastApplied = to;
  }

  // A form with a default priority was configured by an admin to file its
  // tickets at that level, and the ticket was created holding it.
  if (!ownedElsewhere && formId) {
    const [form] = await tx
      .select({ defaultPriority: ticketForms.defaultPriority })
      .from(ticketForms)
      .where(eq(ticketForms.id, formId))
      .limit(1);
    if (form?.defaultPriority) ownedElsewhere = true;
  }

  const [confident] = await tx
    .select({ id: aiPriorityRuns.id })
    .from(aiPriorityRuns)
    .where(
      and(
        eq(aiPriorityRuns.conversationId, conversationId),
        ne(aiPriorityRuns.messageId, messageId),
        inArray(aiPriorityRuns.outcome, [...CONFIDENT_OUTCOMES]),
      ),
    )
    .limit(1);

  return { ownedElsewhere, lastApplied, firstConfident: !confident };
}

async function recordFailure(
  conversationId: string,
  messageId: string,
  mode: Exclude<PriorityAiMode, 'off'>,
  withContext: boolean,
  error: unknown,
): Promise<void> {
  const [ticket] = await db
    .select({ priority: conversations.priority })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!ticket) return;

  await db
    .insert(aiPriorityRuns)
    .values({
      conversationId,
      messageId,
      mode,
      withContext,
      priorityBefore: ticket.priority,
      outcome: 'failed',
      error: errorMessage(error),
    })
    .onConflictDoNothing({ target: aiPriorityRuns.messageId });
}
