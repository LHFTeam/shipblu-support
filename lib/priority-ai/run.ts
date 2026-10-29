import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiPriorityRuns, conversationEvents, conversations, messages } from '@/db/schema';
import { earlierMessages } from '@/lib/subcategorise-ai/context';
import { predictionFrom, type AiPrediction } from '@/lib/subcategorise-ai/map';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';
import { clockInputsIfInFlight, deferToRouter } from '@/lib/routing/state';
import { onPriorityChanged, onPriorityChangedIn } from '@/lib/sla';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { skipReason } from '@/lib/tickets/classifiable';
import { notReaction } from '@/lib/tickets/not-reaction';
import { PRIORITIES, isPriority, type Priority } from '@/lib/tickets/vocabulary';
import {
  TypeSafeApiError,
  choiceAnswer,
  type SystemOneResponse,
  systemOne,
  typesafeConfigured,
  typesafeModel,
} from '@/lib/typesafe/client';
import { CONFIDENT_OUTCOMES, DEFAULT_PRIORITY, decide, type PriorityOutcome } from './decide';
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
      authorContactId: messages.authorContactId,
      requesterContactId: conversations.requesterContactId,
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
  // and stops, rather than paying for a second answer it could not record. A
  // `failed` row is not an answer: it is a gap, and a run by hand after the key
  // is fixed fills it — which is the only way it can be, since the job's dedupe
  // key is spent.
  const [existing] = await db
    .select({ id: aiPriorityRuns.id })
    .from(aiPriorityRuns)
    .where(and(eq(aiPriorityRuns.messageId, messageId), ne(aiPriorityRuns.outcome, 'failed')))
    .limit(1);
  if (existing) return { status: 'already_classified' };

  const withContext = true;
  const earlier = await earlierMessages(row.conversationId, row.createdAt, row.authorContactId);
  const request = priorityRequest(
    { channel: row.channel, bodyText: row.bodyText, earlier },
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

  // For the re-time a deferral owes inside the transaction below
  // (`onPriorityChangedIn`), so read before it opens; only where the answer
  // can be written at all, and only on a decision in flight
  // (`clockInputsIfInFlight`).
  const clocks = mode === 'apply' ? await clockInputsIfInFlight(row.conversationId) : null;

  // Decided and written in one transaction, with the ticket row locked, so an
  // agent's change cannot land between reading the priority and writing over it.
  // The lock is held for a handful of indexed reads — the provider call is
  // already over — and it is the same row an agent's priority change locks.
  const written = await db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({ priority: conversations.priority })
      .from(conversations)
      .where(eq(conversations.id, row.conversationId))
      .for('update')
      .limit(1);
    if (!ticket) return null;

    const facts = await priorityFacts(tx, {
      conversationId: row.conversationId,
      mode,
      messageId,
      createdAt: row.createdAt,
    });

    // Shadow mode writes nothing, so left alone every later message on a ticket
    // would be weighed against `medium` and never against the level shadow mode
    // itself said it would have set — measuring a classifier that cannot ratchet,
    // which is not the one `apply` turns on. So it weighs each answer against
    // its own last `would_apply`, as though that had been written. Only while
    // the column still holds the default: anything else is somebody's choice,
    // and the real value has to win the ownership check.
    const simulated =
      mode === 'shadow' && ticket.priority === DEFAULT_PRIORITY ? facts.lastWouldApply : null;

    const decision = decide({
      mode,
      predicted,
      probability: prediction.probability,
      minProbability: priorityAiMinProbability(),
      current: simulated ?? ticket.priority,
      lastApplied: simulated ?? facts.lastApplied,
      ownedElsewhere: facts.ownedElsewhere,
      // Opening by timestamp *and* by evidence: jobs run concurrently and retry
      // out of order, so the opening message can be answered after a later one
      // has already raised the ticket. Without the second test its "hello"
      // would then lower a ticket another message made urgent.
      firstMessage: facts.opening && !facts.otherConfident,
    });

    // Stamped now, under the lock, rather than with the column default: `now()`
    // is when the transaction began, and two jobs for one ticket can begin in
    // one order and take the lock in the other. `priorityFacts` reads the
    // classifier's last write by these stamps, so a later write carrying the
    // earlier one reads as overwritten — the column then disagrees with what it
    // "last applied", and every answer after is refused as somebody else's.
    // The console and the `set_priority` rule stamp their events the same way,
    // so an agent's change that waited on this lock sorts after it.
    const lockedAt = CHANGE_STAMP;

    // The run row first. Two deliveries of one job racing past the check above
    // are already serialised by the row lock — the second reads the first's
    // write and decides it unchanged — but its own answer has nowhere to go:
    // one row per message is the table's promise. So the unique index settles
    // which delivery's answer is the record, and the loser writes nothing
    // further and reports nothing it did not record. Only a `failed` row gives
    // way, to the first real answer for its message.
    const run = {
      ...runFields,
      priorityBefore: ticket.priority,
      outcome: decision.outcome,
      createdAt: lockedAt,
    };
    const inserted = await tx
      .insert(aiPriorityRuns)
      .values(run)
      .onConflictDoUpdate({
        target: aiPriorityRuns.messageId,
        set: run,
        setWhere: eq(aiPriorityRuns.outcome, 'failed'),
      })
      .returning({ id: aiPriorityRuns.id });
    if (inserted.length === 0) return 'duplicate';

    let deferred = false;
    let retimed = false;
    if (decision.to) {
      await tx
        .update(conversations)
        .set({ priority: decision.to })
        .where(eq(conversations.id, row.conversationId));
      await tx.insert(conversationEvents).values({
        conversationId: row.conversationId,
        type: 'priority_changed',
        actorLabel: PRIORITY_AI_ACTOR,
        createdAt: lockedAt,
        data: {
          to: decision.to,
          from: ticket.priority,
          probability: prediction.probability,
          model: response.model,
          messageId,
        },
      });
      // On a decision in flight the router's pass, run again on what this
      // wrote, is the one owed, as for an agent's edit (`deferToRouter`): run
      // below, after the commit, a rule keyed on priority could move the
      // ticket after the router had handed it to somebody in the group it was
      // leaving. And the clocks move here, when their inputs were read
      // beforehand, since that pass reads the ticket as soon as this commits,
      // and a rule asking whether it is overdue must read the urgent
      // deadline, as the pass below would.
      deferred = await deferToRouter(tx, row.conversationId);
      if (deferred && clocks) {
        await onPriorityChangedIn(tx, row.conversationId, clocks);
        retimed = true;
      }
    }

    return { outcome: decision.outcome, deferred, retimed };
  });

  // A ticket deleted between the two reads cascades its run rows with it, so
  // there is nothing to record and nothing to tell anybody.
  if (written === null) return { status: 'gone' };
  if (written === 'duplicate') return { status: 'already_classified' };
  const { outcome, deferred, retimed } = written;

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
    // already written. Unless the clocks moved in its transaction, ahead of
    // the router's pass it handed its own to; a deferral with no inputs to
    // move them with moves them here.
    if (!retimed) await onPriorityChanged(row.conversationId);

    // Then the observer rules and auto-assignment, exactly as after a console
    // edit, so a rule keyed on priority — "urgent → the escalations group" —
    // fires for a ticket Jev raised, which is the ticket it was written for.
    // The pass the message's own ingest ran saw the priority from before this
    // answer. Only an applied change: shadow and refused answers moved nothing
    // a rule could react to. Best-effort inside, like the SLA call above.
    //
    // What it costs is what an agent's edit costs, and two parts of it are
    // easy to misread. On a new ticket this is the ticket's *first* `on_update`
    // pass — ingest ran only `on_create` — so every `on_update` rule whose
    // conditions hold fires at creation, not only the ones about priority. And
    // nothing orders it after `on_create`: every ingest path enqueues this job
    // (`afterMessageStored`) before it runs that pass (`afterInboundMessage`),
    // and the worker's pool hands the job a free slot as soon as it is queued —
    // inside the `process_webhook` job that is still ingesting, on email,
    // WhatsApp and Meta, and beside the request on web chat, the portal and
    // forms. Only the provider's latency, seconds against a few writes, keeps
    // this pass second; when it is not, an `on_create` rule writing the same
    // field has the last word. A `send_reply` rule that already answered since
    // the customer last wrote is held off by `alreadyReplied` either way.
    //
    // Not when the write handed the pass to the router, which runs it on the
    // ticket as this left it, and assigns after it.
    if (!deferred) await afterTicketUpdate(row.conversationId);
  }

  return { status: 'recorded', outcome, predicted };
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
  {
    conversationId,
    mode,
    messageId,
    createdAt,
  }: {
    conversationId: string;
    mode: Exclude<PriorityAiMode, 'off'>;
    messageId: string;
    createdAt: Date;
  },
): Promise<{
  ownedElsewhere: boolean;
  lastApplied: Priority | null;
  lastWouldApply: Priority | null;
  opening: boolean;
  otherConfident: boolean;
}> {
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
    // on the new-ticket form — leaving it at the default is a choice too, and
    // that one writes no `priority_changed`. A form's own default or a
    // customer's answer does, as `form:<slug>` (`createTicket`), so it falls to
    // the branch below and the form is never read as it stands now.
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

  let lastWouldApply: Priority | null = null;
  if (mode === 'shadow') {
    const [shadowed] = await tx
      .select({ predicted: aiPriorityRuns.predicted })
      .from(aiPriorityRuns)
      .where(
        and(
          eq(aiPriorityRuns.conversationId, conversationId),
          eq(aiPriorityRuns.outcome, 'would_apply'),
        ),
      )
      .orderBy(desc(aiPriorityRuns.createdAt))
      .limit(1);
    lastWouldApply = shadowed?.predicted ?? null;
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

  // The customer's opening message: no other inbound reply at or before it.
  // At, and not only before: WhatsApp stamps a message to the whole second, so
  // a burst shares one, and the strict `<` that is right for choosing context
  // would let each message of the burst count as the opening — and lower. With
  // a tie neither does, which is the direction rule 3 errs in. A caption-less
  // photo counts: it was the opening, though there was nothing to ask about it.
  const [before] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.kind, 'reply'),
        eq(messages.direction, 'inbound'),
        ne(messages.id, messageId),
        sql`${messages.createdAt} <= ${createdAt.toISOString()}::timestamptz`,
        sql`btrim(${messages.bodyText}) <> ''`,
        // A 👍 on the business's first message was not the customer opening.
        notReaction(),
      ),
    )
    .limit(1);

  return {
    ownedElsewhere,
    lastApplied,
    lastWouldApply,
    opening: !before,
    otherConfident: Boolean(confident),
  };
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
