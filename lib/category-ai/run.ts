import { and, asc, count, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  CATEGORY_AI_LIVE_LABEL,
  aiCategoryRuns,
  conversationEvents,
  conversations,
  messages,
  routingDecisions,
  ticketCategories,
} from '@/db/schema';
import {
  holdCategory,
  setConversationCategoryOn,
  type CategoryWrite,
} from '@/lib/categories/write';
import { earlierMessages } from '@/lib/subcategorise-ai/context';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';
import { routeNow } from '@/lib/routing/apply';
import { undecidedRouting } from '@/lib/routing/state';
import { afterRoutingChanged } from '@/lib/sla';
import { isCommentTicket } from '@/lib/tickets/channel-policy';
import { skipReason } from '@/lib/tickets/classifiable';
import { lockedStatusCategory, statusCategoryOf } from '@/lib/tickets/status-category';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { TypeSafeApiError, typesafeConfigured, typesafeModel } from '@/lib/typesafe/client';
import { categoryBaseline } from './baseline';
import {
  CATEGORY_AI_ACTOR,
  CLASSIFIED_MESSAGE_CAP,
  arrivedBefore,
  categoryOwned,
  decide,
  ownedByEvent,
  preCallOutcome,
  settlingOutcomes,
  type CategoryOutcome,
  type TicketFacts,
} from './decide';
import { categoryOptionsForAi } from './options';
import { categoryRequest, questionFingerprint } from './request';
import {
  askJev,
  categorySkipReason,
  classifiableColumns,
  insertRun,
  queueRefusal,
  recordFailure,
  type Executor,
} from './runs';
import { readCategoryAiSettings } from './settings';

const log = logger('classify_category');

/**
 * One inbound message, asked of Jev, recorded, and — when the answer is
 * confident, settles the ticket and nobody else owns its category — written
 * (`plans/ticket-category-routing.md`, decision 4; the rules are in
 * `decide.ts`).
 *
 * Everything the enqueue side checked is checked again here, because the job
 * can run minutes later, after a retry, after the switch was turned off, or by
 * hand. The settings are read uncached: a job that cannot read its switch goes
 * back to the queue rather than guessing it, and turning the classifier off
 * stops the jobs already queued at once. They are read again under the
 * ticket's lock once Jev has answered, so a job already waiting on the call
 * when an admin switches it off, or back to shadow, decides by the switch as it
 * is then.
 */

export type ClassifyResult =
  | { status: 'gone' }
  | { status: 'skipped'; reason: string }
  | { status: 'already_classified' }
  | { status: 'recorded'; outcome: CategoryOutcome; predicted: string | null };

export type ClassifyOptions = {
  /** Overridden by tests and by nothing else. */
  baseUrl?: string;
  timeoutMs?: number;
};

export async function classifyMessageCategory(
  messageId: string,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const settings = await readCategoryAiSettings();
  const mode = settings.mode;
  if (mode === 'off') return { status: 'skipped', reason: 'the category classifier is off' };
  if (!typesafeConfigured()) return { status: 'skipped', reason: 'TYPESAFE_API_KEY is not set' };

  const [row] = await db
    .select(classifiableColumns)
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!row) return { status: 'gone' };

  const skip = skipReason(row) ?? categorySkipReason(row);
  if (skip) return { status: 'skipped', reason: skip };

  // A redelivered job — the worker died after committing — finds its own row
  // and stops. A `failed` row is a gap, filled by a run by hand.
  const [existing] = await db
    .select({ id: aiCategoryRuns.id })
    .from(aiCategoryRuns)
    .where(
      and(
        eq(aiCategoryRuns.messageId, messageId),
        eq(aiCategoryRuns.runLabel, CATEGORY_AI_LIVE_LABEL),
        ne(aiCategoryRuns.outcome, 'failed'),
      ),
    )
    .limit(1);
  if (existing) return { status: 'already_classified' };

  const withContext = true;
  const categoryOptions = await categoryOptionsForAi();

  // A question that cannot be built — no active category, or one named
  // `unknown` — is a configuration state, the same for every message, so it
  // is logged and skipped rather than written as a failed row per message.
  // Its fingerprint is all a row decided without asking needs, so the
  // message's context is read only once Jev is going to be asked.
  let fingerprint: string;
  try {
    fingerprint = questionFingerprint(categoryOptions);
  } catch (error) {
    log.error(`could not build the category question for message ${messageId}`, error);
    return { status: 'skipped', reason: `the question could not be built: ${errorMessage(error)}` };
  }

  const baseline = categoryBaseline(row.bodyText);
  const fields = {
    conversationId: row.conversationId,
    messageId,
    messageCreatedAt: row.createdAt,
    runLabel: CATEGORY_AI_LIVE_LABEL,
    mode,
    requestFingerprint: fingerprint,
    withContext,
    minProbability: settings.minProbability,
    baselineCategoryKey: baseline.categoryKey,
    baselineSubcategoryKeys: baseline.subcategoryKeys,
    channel: row.channel,
    channelId: row.channelId,
    hasShipment: row.hasShipment,
    requesterKind: row.requesterKind,
  };
  const at = { messageId, createdAt: row.createdAt };

  // What is known before asking: owned, settled and capped are each final —
  // nothing removes the event, the earlier settle or the reply that made them
  // so — so the outcome is recorded without paying for an answer, and every
  // message this job decides about has exactly one live row. Read without the
  // lock for that reason: an answer that is final when read is final when
  // written. Ownership only by its events: the column is read in a statement
  // apart from them, and a Jev write committing in between reads as a column
  // somebody else moved — final, and wrong. The look under the lock after the
  // call reads both halves in one place.
  const current = await readTicket(db, row.conversationId, false);
  if (!current) return { status: 'gone' };
  const leftBefore = queueRefusal(current);
  if (leftBefore) return { status: 'skipped', reason: leftBefore };
  const known = await ticketFacts(db, row.conversationId, current, at, mode);
  const before = preCallOutcome({ ...known, owned: known.ownedByEvent });
  if (before) {
    const inserted = await insertRun(db, {
      ...fields,
      outcome: before,
      categoryKeyBefore: current.categoryKey,
    });
    if (!inserted) return { status: 'already_classified' };
    return { status: 'recorded', outcome: before, predicted: null };
  }

  const context = await earlierMessages(row.conversationId, row.createdAt, row.authorContactId);
  const built = categoryRequest(
    {
      channel: row.channel,
      bodyText: row.bodyText,
      earlier: context,
      isPublicComment: isCommentTicket(row.channel, row.externalId),
    },
    categoryOptions,
    typesafeModel(),
    withContext,
  );

  let asked: Awaited<ReturnType<typeof askJev>>;
  try {
    asked = await askJev(built.request, built.offered, options);
  } catch (error) {
    // Transient goes back to the queue, whose backoff is the retry policy.
    // Permanent — a wrong key, an answer naming a key nobody offered — is
    // recorded and not retried; the ticket keeps its category.
    if (!(error instanceof TypeSafeApiError) || error.isTransient) throw error;
    log.error(`could not classify message ${messageId}`, error);
    await recordFailure({ ...fields, error: errorMessage(error) });
    return { status: 'recorded', outcome: 'failed', predicted: null };
  }

  const { response, prediction } = asked;
  const predicted = prediction.key;
  const answered = {
    ...fields,
    model: response.model,
    predictedKey: predicted,
    probability: prediction.probability,
    confidence: prediction.confidence,
    probabilities: prediction.probabilities,
    inputTokens: response.inputTokens,
    latencyMs: asked.latencyMs,
  };

  // Decided and written in one transaction, with the ticket row locked, so a
  // person's choice or another message's settle cannot land between reading
  // the facts and writing over them. The provider call is over; the lock is
  // held for a handful of indexed reads.
  const decided = await db.transaction(async (tx) => {
    const ticket = await readTicket(tx, row.conversationId, true);
    if (!ticket) return null;
    // Deleted, marked spam, merged, resolved or closed while Jev was asked:
    // nobody's queue holds it any more, so nothing is written and no rule pass
    // is owed.
    const left = queueRefusal(ticket);
    if (left) return { kind: 'left' as const, reason: left };

    // The switch as it is now, not as it was before the call: an admin who
    // turns the classifier off because of what it filed stops this write too.
    // Off is the switch found off, which leaves no row.
    const now = await readCategoryAiSettings(tx);
    if (now.mode === 'off') {
      return { kind: 'left' as const, reason: 'the category classifier was switched off' };
    }

    const facts = await ticketFacts(tx, row.conversationId, ticket, at, now.mode);
    let outcome: CategoryOutcome = decide({
      ...facts,
      mode: now.mode,
      predictedKey: predicted,
      probability: prediction.probability,
      minProbability: now.minProbability,
    });

    // The category held before the run row is written, so a category an admin
    // retired while Jev was being asked is recorded as the failure it is
    // rather than as a write that then did not happen. In shadow too, which
    // would otherwise settle on an answer `apply` could not write. A failed
    // row does not settle, does not count towards the cap, and a run by hand
    // fills it.
    const categoryId =
      outcome === 'applied' || outcome === 'would_apply' ? built.keyToId[predicted] : undefined;
    let error: string | null = null;
    if (categoryId) {
      const held = await holdCategory(tx, categoryId);
      if (typeof held === 'string') {
        outcome = 'failed';
        error = `category ${predicted} was ${held === 'retired_category' ? 'retired' : 'removed'} while Jev was asked`;
      }
    }

    // The run row first, so a second delivery racing this one is settled by
    // the unique index before either writes the column: one answer per message
    // per label is the table's promise, and only a `failed` row gives way.
    const inserted = await insertRun(tx, {
      ...answered,
      mode: now.mode,
      minProbability: now.minProbability,
      outcome,
      error,
      categoryKeyBefore: ticket.categoryKey,
      createdAt: CHANGE_STAMP,
    });
    if (!inserted) return 'duplicate' as const;
    if (outcome !== 'applied' || !categoryId)
      return { kind: 'decided' as const, outcome, write: null };

    const write = await setConversationCategoryOn(
      tx,
      row.conversationId,
      categoryId,
      { label: CATEGORY_AI_ACTOR },
      {
        probability: prediction.probability,
        model: response.model,
        messageId,
        messageCreatedAt: row.createdAt.toISOString(),
        runLabel: CATEGORY_AI_LIVE_LABEL,
      },
    );
    // Under the lock the write holds, because the stage moves under it.
    const routing = await undecidedRouting(tx, row.conversationId);
    return { kind: 'decided' as const, outcome, write, routing };
  });

  if (decided === null) return { status: 'gone' };
  if (decided === 'duplicate') return { status: 'already_classified' };
  if (decided.kind === 'left') return { status: 'skipped', reason: decided.reason };

  if (decided.write?.outcome === 'changed') {
    log.info('applied', {
      messageId,
      conversationId: row.conversationId,
      to: predicted,
      probability: prediction.probability,
    });
    await afterCategoryApplied(row.conversationId, decided.write, decided.routing ?? null);
  }

  return { status: 'recorded', outcome: decided.outcome, predicted };
}

/**
 * What a written category owes once it has committed, which depends on where
 * the ticket's routing stands (`plans/ticket-category-routing.md`, decision 5):
 *
 * - **Live and `pending`** — the creation pass has not reached `beginRouting`,
 *   which routes on this category. Nothing more here, so a rule always gets
 *   the first word.
 * - **Live and `holding`** — routed now (`routeNow`), *instead of* the update
 *   pass below: the router runs that pass itself, between its decision and the
 *   assignment, and a second would assign before the first had finished. If
 *   somebody decided in the moment between this commit and the router's lock,
 *   the router answers `none`, and who it was says what is owed
 *   (`decidedByHold`): a person or a rule, and this is a relabel after all; the
 *   router itself, and nothing is.
 * - **Undecided shadow** — the rest as though routing did not exist, after
 *   recording the would-be decision once the creation pass has begun routing
 *   (`holding`); while it is `pending`, `beginRouting` records it after the
 *   `on_create` rules, so in shadow too a rule gets the first word.
 * - **Anything else** — never routed, or decided already, and so a relabel
 *   only: the SLA policy chosen again before the first reply, then the
 *   observer rules and auto-assignment, exactly as after a console edit — so a
 *   rule keyed on the category fires for a ticket Jev filed. Both best-effort
 *   inside.
 *
 * Only a write that changed the column: setting what the ticket already
 * carries wrote nothing a rule could react to.
 *
 * Owed after the commit and kept nowhere, priority's gap too: a worker that
 * dies between the two leaves the category written and this unrun, and the
 * redelivered job finds its own row and stops. The ticket then waits for its
 * next routing change, or a person's, to be re-timed and to meet its rules.
 */
async function afterCategoryApplied(
  conversationId: string,
  write: CategoryWrite,
  routing: Awaited<ReturnType<typeof undecidedRouting>>,
): Promise<void> {
  if (routing && !routing.shadow) {
    if (routing.stage === 'pending') return;
    const routed = await routeNow(conversationId, { label: CATEGORY_AI_ACTOR });
    if (routed !== 'none') return;
    if (!(await decidedByHold(conversationId))) return;
  } else if (routing?.stage === 'holding') {
    await routeNow(conversationId, { label: CATEGORY_AI_ACTOR });
  }
  await afterRoutingChanged(conversationId, {
    category: write.outcome === 'changed',
    group: false,
  });
  await afterTicketUpdate(conversationId);
}

/**
 * Whether the decision on a ticket this write found held was made since by
 * `endHold` — a person or a rule deciding where the ticket goes — rather than
 * by the router. Asked only once `routeNow` has answered `none` there: somebody
 * decided in the moment between this write's commit and the router's lock.
 *
 * The router — the window's end, a person's category edit, this answer racing
 * another message's — decided under the ticket's lock after the commit, so on
 * the ticket carrying this category, and ran the update pass that decision
 * owed (`lib/routing/apply.ts`), or found the ticket in nobody's queue and
 * owed none. A relabel after it is a second pass, and every rule keyed on the
 * category fires twice: a canned reply sent twice, a note written twice — or
 * a first, on a ticket resolved in that moment. `endHold` decides without
 * looking at the category at all, so after a person or a rule the relabel is
 * still owed. A person ending a hold whose phase one the router had already
 * written keeps the router's outcome, and the router still runs the pass: it
 * claims it on `rules_claimed_at` alone, so a hold a person ended under it
 * costs nothing phase one owed (`finish` in `lib/routing/apply.ts`), and a
 * relabel here would be a second pass.
 */
async function decidedByHold(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ outcome: routingDecisions.outcome })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId));
  return row?.outcome === 'manual' || row?.outcome === 'rule';
}

type TicketState = {
  categoryId: string | null;
  categoryKey: string | null;
  firstRespondedAt: Date | null;
  deletedAt: Date | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  statusCategory: string;
};

/**
 * The ticket's category and whether anybody has answered it, and the key of
 * the category it carries; null when the ticket is gone. Locked when the
 * answer is about to be acted on.
 * The status through `statusCategoryOf`, never a join: a writer moving the
 * ticket to another status while this waits for the lock would otherwise
 * make the ticket read as gone, and the job go to `dead`.
 */
async function readTicket(
  executor: Executor,
  conversationId: string,
  lock: boolean,
): Promise<TicketState | null> {
  const query = executor
    .select({
      categoryId: conversations.categoryId,
      firstRespondedAt: conversations.firstRespondedAt,
      deletedAt: conversations.deletedAt,
      isSpam: conversations.isSpam,
      mergedIntoId: conversations.mergedIntoId,
      statusId: conversations.statusId,
      statusCategory: statusCategoryOf(),
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const [read] = lock ? await query.for('update') : await query;
  if (!read) return null;
  const ticket = { ...read, statusCategory: await lockedStatusCategory(executor, read) };

  let categoryKey: string | null = null;
  if (ticket.categoryId) {
    const [category] = await executor
      .select({ key: ticketCategories.key })
      .from(ticketCategories)
      .where(eq(ticketCategories.id, ticket.categoryId))
      .limit(1);
    categoryKey = category?.key ?? null;
  }
  return { ...ticket, categoryKey };
}

/**
 * Who owns the ticket's category, whether a message written before this one
 * settled it, and whether the ticket is past asking — read inside the
 * transaction that holds the ticket's row, so the answer cannot be stale by
 * the time it is acted on.
 *
 * Settled by a live run on an earlier message with a settling outcome, or by
 * an earlier message whose answer Jev wrote under another label — a backfill
 * in apply mode, whose event names the message it answered and when it was
 * written. "Earlier" is the message's own `created_at`, then its id: WhatsApp
 * stamps a burst to the same second, and the id makes exactly one of them the
 * first.
 */
async function ticketFacts(
  executor: Executor,
  conversationId: string,
  ticket: TicketState,
  at: { messageId: string; createdAt: Date },
  mode: 'shadow' | 'apply',
): Promise<TicketFacts & { ownedByEvent: boolean }> {
  const events = await executor
    .select({
      type: conversationEvents.type,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ['category_changed', 'opened_by_agent']),
      ),
    )
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));

  const owned = categoryOwned(events, ticket.categoryId);

  const settledByWrite = events.some((event) => {
    if (event.type !== 'category_changed' || event.actorLabel !== CATEGORY_AI_ACTOR) return false;
    const data = event.data as Record<string, unknown> | null;
    const writtenAt = typeof data?.messageCreatedAt === 'string' ? data.messageCreatedAt : null;
    const answered = typeof data?.messageId === 'string' ? data.messageId : null;
    return (
      writtenAt !== null &&
      arrivedBefore({ createdAt: new Date(writtenAt), messageId: answered }, at) < 0
    );
  });

  const [settling] = await executor
    .select({ id: aiCategoryRuns.id })
    .from(aiCategoryRuns)
    .where(
      and(
        eq(aiCategoryRuns.conversationId, conversationId),
        eq(aiCategoryRuns.runLabel, CATEGORY_AI_LIVE_LABEL),
        inArray(aiCategoryRuns.outcome, [...settlingOutcomes(mode)]),
        // A settling row whose message was deleted since compares null on a
        // tie of the instant and is not counted; on any other instant the
        // tuple decides on the time alone. A deletion tied to the millisecond
        // with the message being asked about is the whole of that edge.
        sql`(${aiCategoryRuns.messageCreatedAt}, ${aiCategoryRuns.messageId}) < (${at.createdAt.toISOString()}::timestamptz, ${at.messageId}::uuid)`,
      ),
    )
    .limit(1);

  // Messages Jev answered: a `failed` row keeps the prediction a retired
  // category refused, and is a gap rather than an answer. `is distinct from`,
  // because a row whose message was deleted since has a null id and still
  // counts — `<>` answers null for it, and the row would drop out of the cap.
  const [asked] = await executor
    .select({ value: count() })
    .from(aiCategoryRuns)
    .where(
      and(
        eq(aiCategoryRuns.conversationId, conversationId),
        eq(aiCategoryRuns.runLabel, CATEGORY_AI_LIVE_LABEL),
        isNotNull(aiCategoryRuns.predictedKey),
        ne(aiCategoryRuns.outcome, 'failed'),
        sql`${aiCategoryRuns.messageId} is distinct from ${at.messageId}::uuid`,
      ),
    );

  return {
    owned,
    ownedByEvent: ownedByEvent(events),
    settled: settledByWrite || Boolean(settling),
    capped: ticket.firstRespondedAt !== null || (asked?.value ?? 0) >= CLASSIFIED_MESSAGE_CAP,
  };
}
