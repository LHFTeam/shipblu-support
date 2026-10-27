import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/db/client';
import {
  CATEGORY_AI_LIVE_LABEL,
  aiCategoryRuns,
  contacts,
  conversationEvents,
  conversationShipments,
  conversations,
  messages,
  ticketCategories,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { activeRules } from '@/lib/automations';
import { setConversationCategoryOn, type CategoryEventDetail } from '@/lib/categories/write';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';
import { matches } from '@/lib/rules/conditions';
import { conversationFacts, type FactSource } from '@/lib/rules/facts';
import { earlierMessages } from '@/lib/subcategorise-ai/context';
import {
  isCommentTicket,
  isReadOnlyChannel,
  readOnlyChannels,
  type ConversationChannel,
} from '@/lib/tickets/channel-policy';
import { skipReason } from '@/lib/tickets/classifiable';
import { TypeSafeApiError, typesafeModel } from '@/lib/typesafe/client';
import { categoryBaseline } from './baseline';
import {
  CATEGORY_AI_ACTOR,
  CLASSIFIED_MESSAGE_CAP,
  categoryOwned,
  decide,
  eventsKnownAt,
  preCallOutcome,
  settlingOutcomes,
  type CategoryOutcome,
} from './decide';
import { categoryOptionsForAi } from './options';
import { categoryQuestion, categoryRequest, questionFingerprint } from './request';
import { askJev, categorySkipReason, classifiableColumns, insertRun, recordFailure } from './runs';
import { readCategoryAiSettings } from './settings';

/**
 * `backfill_category_ai`: Jev's category classifier over tickets it never saw
 * live (`plans/ticket-category-routing.md`, Stage 4.1). Two modes, and they do
 * not share a write:
 *
 * - **`record`** asks Jev about the archive and writes only `ai_category_runs`,
 *   under a label of its own, so labelled evaluation can start on what is
 *   already there rather than after weeks of new traffic. Every message is
 *   judged as of the moment it arrived — who owned the ticket then, whether an
 *   earlier message had settled it, whether anybody had answered — because
 *   what is true of the ticket now would read every ticket a supervisor has
 *   since labelled as owned, and empty the evaluation of the very tickets it
 *   is graded on.
 * - **`apply`** files open tickets from a record label's settling answers, and
 *   nothing else. It asks nobody: it applies exactly what was evaluated, so a
 *   question changed since — a category added, renamed, retired — refuses the
 *   label rather than mixing two questions' answers. It respects ownership
 *   under the row lock and fires nothing: no rule pass, no SLA hook, no
 *   router, so neither `on_update` rules nor the open backlog's deadlines move.
 *   Its report says which rules would now match, `time_based` ones included,
 *   since the sweep re-reads every live ticket every 15 minutes.
 */

const log = logger('backfill_category_ai');

/**
 * The first day of traffic the team answers here, where the archive the plan
 * measures starts (532 human tickets by 2026-10-20): the default `since`.
 */
export const ARCHIVE_STARTS = '2026-08-18';

const BATCH = 100;

type Scope = {
  channels: ConversationChannel[] | null;
  /** Tickets opened from, inclusive. */
  since?: Date;
  /** Tickets opened before, exclusive. */
  until?: Date;
  /** Stop after this many tickets. */
  limit?: number;
  dryRun: boolean;
};

export type RecordRun = Scope & {
  runLabel: string;
  /** Overridden by tests and by nothing else. */
  call?: { baseUrl?: string; timeoutMs?: number };
};

export type RecordTally = {
  tickets: number;
  /** Messages the classifier never asks about: a passer-by's, machine mail, no words. */
  skipped: number;
  /** Already answered under this label, by an earlier run of it. */
  resumed: number;
  /** Asked of Jev — or, in a dry run, that would have been. */
  asked: number;
  /** A transient failure, which stopped its ticket until the label is run again. */
  transient: number;
  outcomes: Record<CategoryOutcome, number>;
};

export type Refused = { status: 'refused'; reason: string };

export type RecordResult = Refused | { status: 'ran'; tallies: Map<string, RecordTally> };

/** Which tickets a run reads, as one list of predicates. */
function ticketScope(scope: Scope): SQL[] {
  const where: SQL[] = [
    ne(conversations.sourceSystem, 'import'),
    isNull(conversations.mergedIntoId),
    isNull(conversations.deletedAt),
    eq(conversations.isSpam, false),
  ];
  where.push(
    scope.channels
      ? inArray(conversations.channel, scope.channels)
      : notInArray(conversations.channel, readOnlyChannels()),
  );
  if (scope.since) where.push(gte(conversations.createdAt, scope.since));
  if (scope.until) where.push(lt(conversations.createdAt, scope.until));
  return where;
}

/** The fingerprints a label's rows carry other than `fingerprint`. */
async function otherFingerprints(runLabel: string, fingerprint: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ fingerprint: aiCategoryRuns.requestFingerprint })
    .from(aiCategoryRuns)
    .where(
      and(
        eq(aiCategoryRuns.runLabel, runLabel),
        ne(aiCategoryRuns.requestFingerprint, fingerprint),
      ),
    );
  return rows.map((row) => row.fingerprint);
}

function emptyTally(): RecordTally {
  return {
    tickets: 0,
    skipped: 0,
    resumed: 0,
    asked: 0,
    transient: 0,
    outcomes: {
      applied: 0,
      would_apply: 0,
      unknown: 0,
      below_threshold: 0,
      owned: 0,
      after_settle: 0,
      capped: 0,
      failed: 0,
    },
  };
}

/**
 * Record mode: every classifiable message on the tickets in scope, in the
 * order they arrived, asked of Jev unless something earlier already decided
 * it. Re-running a label fills its gaps and nothing else: a message with an
 * answer under the label is read rather than asked, and a `failed` row is the
 * only one that gives way.
 */
export async function recordCategoryRun(run: RecordRun): Promise<RecordResult> {
  if (run.runLabel === CATEGORY_AI_LIVE_LABEL) {
    return { status: 'refused', reason: `"${CATEGORY_AI_LIVE_LABEL}" is the live classifier's` };
  }

  const settings = await readCategoryAiSettings();
  const options = await categoryOptionsForAi();
  // An empty registry is a database nobody has seeded. A dry run carries on
  // past it, for the reason `backfill_subcategorise_ai` gives: CI's line puts
  // the settings, registry, label and ticket-scan queries in front of a real
  // Postgres. Its database holds no tickets, so the per-ticket queries and
  // apply mode's are run by `backfill.db.test.ts`, in the same CI job.
  if (options.length === 0 && !run.dryRun) {
    return { status: 'refused', reason: 'no active categories to offer' };
  }
  const fingerprint = options.length > 0 ? questionFingerprint(options) : null;
  if (fingerprint) {
    const others = await otherFingerprints(run.runLabel, fingerprint);
    if (others.length > 0) {
      return {
        status: 'refused',
        reason: `"${run.runLabel}" answered another question (${others.join(', ')}) — start a new label`,
      };
    }
  }

  // Retired ones too: a ticket filed under a category retired since was filed
  // under it at the time.
  const keys = new Map(
    (
      await db.select({ id: ticketCategories.id, key: ticketCategories.key }).from(ticketCategories)
    ).map((row) => [row.id, row.key]),
  );
  const context: TicketContext = {
    run,
    options,
    fingerprint: fingerprint ?? '',
    model: typesafeModel(),
    minProbability: settings.minProbability,
    keys,
    tallies: new Map(),
  };

  let cursor: string | null = null;
  let seen = 0;
  for (;;) {
    const remaining = run.limit ? run.limit - seen : BATCH;
    if (remaining <= 0) break;
    const batch = await db
      .select({ id: conversations.id, channel: conversations.channel })
      .from(conversations)
      .where(and(...ticketScope(run), cursor ? gt(conversations.id, cursor) : undefined))
      .orderBy(asc(conversations.id))
      .limit(Math.min(BATCH, remaining));
    if (batch.length === 0) break;

    for (const ticket of batch) {
      seen += 1;
      cursor = ticket.id;
      await recordTicket(ticket.id, ticket.channel, context);
    }
  }

  return { status: 'ran', tallies: context.tallies };
}

type TicketContext = {
  run: RecordRun;
  options: Awaited<ReturnType<typeof categoryOptionsForAi>>;
  fingerprint: string;
  model: string;
  minProbability: number;
  keys: Map<string, string>;
  tallies: Map<string, RecordTally>;
};

/** Whether a message came before another: its `created_at`, then its id, as the live run orders them. */
function arrivedBefore(
  a: { createdAt: Date; messageId: string },
  b: { createdAt: Date; messageId: string },
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

async function recordTicket(
  conversationId: string,
  channel: string,
  context: TicketContext,
): Promise<void> {
  const { run } = context;
  const tally = context.tallies.get(channel) ?? emptyTally();
  context.tallies.set(channel, tally);
  tally.tickets += 1;

  // Only inbound replies can be classifiable; ordered here as the live run
  // compares them, to the millisecond and then by id.
  const rows = (
    await db
      .select(classifiableColumns)
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.kind, 'reply'),
          eq(messages.direction, 'inbound'),
        ),
      )
  ).sort(arrivedBefore);
  if (rows.length === 0) return;

  const events = await db
    .select({
      type: conversationEvents.type,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
      createdAt: conversationEvents.createdAt,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ['category_changed', 'opened_by_agent']),
      ),
    )
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));

  const answered = new Map(
    (
      await db
        .select({
          messageId: aiCategoryRuns.messageId,
          outcome: aiCategoryRuns.outcome,
          predictedKey: aiCategoryRuns.predictedKey,
        })
        .from(aiCategoryRuns)
        .where(
          and(
            eq(aiCategoryRuns.conversationId, conversationId),
            eq(aiCategoryRuns.runLabel, run.runLabel),
            ne(aiCategoryRuns.outcome, 'failed'),
            isNotNull(aiCategoryRuns.messageId),
          ),
        )
    ).map((row) => [row.messageId!, row]),
  );

  // A shipment is linked by the time of a message when its link was made by
  // then, or was made from a message — the customer's, a reply or a note —
  // written by then. The second half is what the live row sees: ingest links
  // a message's tracking number before it queues the job, so a link is always
  // stamped after its own message, and `backfill_shipment_links` stamps the
  // links it makes when it runs. That backfill links a number from whichever
  // message it reaches first, in no order, so a number repeated later can
  // read as linked only from the repeat.
  const links = await db
    .select({ createdAt: conversationShipments.createdAt, detectedAt: messages.createdAt })
    .from(conversationShipments)
    .leftJoin(messages, eq(messages.id, conversationShipments.detectedInMessageId))
    .where(eq(conversationShipments.conversationId, conversationId));
  const linkedBy = (message: { createdAt: Date }) =>
    links.some(
      (link) =>
        link.createdAt <= message.createdAt ||
        (link.detectedAt !== null && link.detectedAt <= message.createdAt),
    );

  let settled = false;
  let asked = 0;
  const settles = settlingOutcomes('record');

  for (const row of rows) {
    if (skipReason(row) ?? categorySkipReason(row)) {
      tally.skipped += 1;
      continue;
    }

    const done = answered.get(row.messageId);
    if (done) {
      tally.resumed += 1;
      if ((settles as readonly string[]).includes(done.outcome)) settled = true;
      if (done.predictedKey !== null) asked += 1;
      continue;
    }

    // As of the message: the events the live job would have read for it
    // (`eventsKnownAt` says which, and why not simply those stamped by then),
    // and the category the last of them left.
    const before = eventsKnownAt(events, row.createdAt);
    const column = lastCategory(before);
    const facts = {
      owned: categoryOwned(before, column),
      settled,
      capped:
        asked >= CLASSIFIED_MESSAGE_CAP ||
        (row.firstRespondedAt !== null && row.firstRespondedAt <= row.createdAt),
    };

    const baseline = categoryBaseline(row.bodyText);
    const fields = {
      conversationId,
      messageId: row.messageId,
      messageCreatedAt: row.createdAt,
      runLabel: run.runLabel,
      mode: 'record',
      requestFingerprint: context.fingerprint,
      withContext: true,
      minProbability: context.minProbability,
      categoryKeyBefore: column ? (context.keys.get(column) ?? null) : null,
      baselineCategoryKey: baseline.categoryKey,
      baselineSubcategoryKeys: baseline.subcategoryKeys,
      channel: row.channel,
      channelId: row.channelId,
      hasShipment: linkedBy(row),
      requesterKind: row.requesterKind,
    };

    const pre = preCallOutcome(facts);
    if (pre) {
      tally.outcomes[pre] += 1;
      if (!run.dryRun) await insertRun(db, { ...fields, outcome: pre });
      continue;
    }

    tally.asked += 1;
    // A dry run builds every body it would send and throws it away, so a
    // question this system can no longer construct fails here first. Not on
    // an empty registry, which `categoryQuestion` refuses by design.
    if (context.options.length === 0) continue;
    const earlier = await earlierMessages(conversationId, row.createdAt, row.authorContactId);
    const built = categoryRequest(
      {
        channel: row.channel,
        bodyText: row.bodyText,
        earlier,
        isPublicComment: isCommentTicket(row.channel, row.externalId),
      },
      context.options,
      context.model,
      true,
    );
    if (run.dryRun) continue;

    let answer: Awaited<ReturnType<typeof askJev>>;
    try {
      answer = await askJev(built.request, built.offered, run.call ?? {});
    } catch (error) {
      if (!(error instanceof TypeSafeApiError)) throw error;
      // The rest of the ticket waits for the gap, either way: recorded past a
      // message nobody has an answer for, its settle and its cap would be
      // read from a history missing one, and a re-run filling the gap could
      // not put them back in order.
      if (error.isTransient) {
        tally.transient += 1;
        log.warn(`stopped ticket ${conversationId} at message ${row.messageId}`, error);
        return;
      }
      await recordFailure({ ...fields, error: errorMessage(error) });
      tally.outcomes.failed += 1;
      return;
    }

    const { response, prediction } = answer;
    const outcome = decide({
      ...facts,
      mode: 'record',
      predictedKey: prediction.key,
      probability: prediction.probability,
      minProbability: context.minProbability,
    });
    await insertRun(db, {
      ...fields,
      model: response.model,
      predictedKey: prediction.key,
      probability: prediction.probability,
      confidence: prediction.confidence,
      probabilities: prediction.probabilities,
      inputTokens: response.inputTokens,
      latencyMs: answer.latencyMs,
      outcome,
    });
    tally.outcomes[outcome] += 1;
    asked += 1;
    if ((settles as readonly string[]).includes(outcome)) settled = true;
  }
}

/** The category the last `category_changed` among `events` left, or null. */
function lastCategory(events: readonly { type: string; data: unknown }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'category_changed') continue;
    const to = (event.data as { to?: unknown } | null)?.to;
    return typeof to === 'string' ? to : null;
  }
  return null;
}

// --------------------------------------------------------------------------
// Apply

export type ApplyRun = Scope & { fromLabel: string };

/** What decides whether a ticket may be filed from a label, read off its row. */
export type ApplyFacts = {
  statusCategory: string;
  channel: string;
  sourceSystem: string;
  isSpam: boolean;
  deletedAt: Date | null;
  mergedIntoId: string | null;
  categoryId: string | null;
  /** A `category_changed` by anybody but Jev, or an agent opening the ticket. */
  ownedByEvent: boolean;
  /** A `category_changed` by Jev: the live classifier or an earlier apply. */
  filedByJev: boolean;
};

/**
 * Why a ticket is not filed from the label, or null when it is: live work,
 * in nobody's hands, never filed by Jev. A ticket Jev already filed is left
 * because `categoryOwned` would call it free — the column holds Jev's last
 * write — and the backfill would put an older answer over a live one.
 */
export function applyRefusal(ticket: ApplyFacts): string | null {
  if (ticket.deletedAt) return 'deleted';
  if (ticket.isSpam) return 'spam';
  if (ticket.mergedIntoId) return 'merged';
  if (ticket.sourceSystem === 'import') return 'imported history';
  if (isReadOnlyChannel(ticket.channel)) return 'a read-only channel';
  if (ticket.statusCategory !== 'open' && ticket.statusCategory !== 'pending') {
    return 'resolved or closed';
  }
  if (ticket.ownedByEvent) return 'owned';
  if (ticket.filedByJev) return 'filed by Jev already';
  // Filed with no event saying by whom: a hand-written update, a test. Theirs,
  // as `categoryOwned` reads it.
  if (ticket.categoryId) return 'owned';
  return null;
}

/** One rule whose answer on the backlog the backfill would change. */
export type RuleReport = {
  trigger: 'on_update' | 'time_based';
  name: string;
  /** Tickets it does not match today and would once filed. */
  newly: number;
  /** Tickets it matches today and would not once filed — an `is_empty` rule. */
  stops: number;
};

export type ApplyResult =
  | Refused
  | {
      status: 'ran';
      /** Tickets with a settling answer under the label, in scope. */
      candidates: number;
      /** Filed, or in a dry run, that would be. */
      applied: number;
      /** Why the others were left, by reason. */
      left: Map<string, number>;
      rules: RuleReport[];
    };

const ownedByEvent = sql<boolean>`exists (
  select 1 from ${conversationEvents}
  where ${conversationEvents.conversationId} = ${conversations.id}
    and (${conversationEvents.type} = 'opened_by_agent'
      or (${conversationEvents.type} = 'category_changed'
        and ${conversationEvents.actorLabel} is distinct from ${CATEGORY_AI_ACTOR})))`;

const filedByJev = sql<boolean>`exists (
  select 1 from ${conversationEvents}
  where ${conversationEvents.conversationId} = ${conversations.id}
    and ${conversationEvents.type} = 'category_changed'
    and ${conversationEvents.actorLabel} = ${CATEGORY_AI_ACTOR})`;

/**
 * Apply mode: each ticket in scope with a settling answer under `fromLabel`
 * — its earliest `would_apply`, the one that settled it — filed under the
 * category that answer names, when the ticket is still open and nobody has
 * filed it.
 */
export async function applyCategoryRun(run: ApplyRun): Promise<ApplyResult> {
  const options = await categoryOptionsForAi();
  if (options.length === 0) return { status: 'refused', reason: 'no active categories to offer' };

  const fingerprint = questionFingerprint(options);
  const labelled = await db
    .selectDistinct({ fingerprint: aiCategoryRuns.requestFingerprint })
    .from(aiCategoryRuns)
    .where(eq(aiCategoryRuns.runLabel, run.fromLabel));
  if (labelled.length === 0) {
    return { status: 'refused', reason: `no rows under "${run.fromLabel}"` };
  }
  const others = labelled.map((row) => row.fingerprint).filter((value) => value !== fingerprint);
  if (others.length > 0) {
    return {
      status: 'refused',
      reason:
        `"${run.fromLabel}" answered another question (${others.join(', ')}) than today's ` +
        `(${fingerprint}) — record a new label and apply that`,
    };
  }
  const { keyToId } = categoryQuestion(options);

  // One per ticket: the earliest settling answer, by when its message
  // arrived. A message deleted since cannot be named in the event, so its
  // answer is passed over.
  const settling = await db
    .selectDistinctOn([aiCategoryRuns.conversationId], {
      messageId: aiCategoryRuns.messageId,
      messageCreatedAt: aiCategoryRuns.messageCreatedAt,
      predictedKey: aiCategoryRuns.predictedKey,
      probability: aiCategoryRuns.probability,
      model: aiCategoryRuns.model,
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      requesterEmail: contacts.primaryEmail,
      formSlug: ticketForms.slug,
      ownedByEvent,
      filedByJev,
    })
    .from(aiCategoryRuns)
    .innerJoin(conversations, eq(conversations.id, aiCategoryRuns.conversationId))
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(ticketForms, eq(ticketForms.id, conversations.formId))
    .where(
      and(
        eq(aiCategoryRuns.runLabel, run.fromLabel),
        eq(aiCategoryRuns.outcome, 'would_apply'),
        isNotNull(aiCategoryRuns.messageId),
        ...scopeOfLabel(run),
      ),
    )
    .orderBy(
      asc(aiCategoryRuns.conversationId),
      asc(aiCategoryRuns.messageCreatedAt),
      asc(aiCategoryRuns.messageId),
    );

  const rules = [
    ...(await activeRules('on_update')).map((rule) => ({ ...rule, trigger: 'on_update' as const })),
    ...(await activeRules('time_based')).map((rule) => ({
      ...rule,
      trigger: 'time_based' as const,
    })),
  ];
  const reports = new Map<string, RuleReport>();
  const left = new Map<string, number>();
  const leave = (reason: string) => left.set(reason, (left.get(reason) ?? 0) + 1);
  const now = new Date();

  let applied = 0;
  let filed = 0;
  for (const answer of settling) {
    const categoryId = answer.predictedKey ? keyToId[answer.predictedKey] : undefined;
    const refusal =
      applyRefusal({ ...answer.conversation, ...answer }) ??
      (categoryId ? null : 'category retired since');
    if (refusal || !categoryId) {
      leave(refusal ?? 'category retired since');
      continue;
    }
    if (run.limit && filed >= run.limit) break;
    filed += 1;

    // What filing it would wake. Only the category changes between the two
    // readings, so a rule whose answer differs is one keyed on it.
    const source: FactSource = {
      conversation: answer.conversation,
      statusCategory: answer.statusCategory,
      requesterEmail: answer.requesterEmail,
      formSlug: answer.formSlug,
    };
    const without = conversationFacts(source, now);
    const withCategory = conversationFacts(
      { ...source, conversation: { ...answer.conversation, categoryId } },
      now,
    );
    for (const rule of rules) {
      const was = matches(rule.conditions, without);
      const would = matches(rule.conditions, withCategory);
      if (was === would) continue;
      const key = `${rule.trigger}:${rule.id}`;
      const report = reports.get(key) ?? {
        trigger: rule.trigger,
        name: rule.name,
        newly: 0,
        stops: 0,
      };
      if (would) report.newly += 1;
      else report.stops += 1;
      reports.set(key, report);
    }

    if (run.dryRun) {
      applied += 1;
      continue;
    }

    const outcome = await fileTicket(answer.conversation.id, categoryId, {
      probability: answer.probability,
      model: answer.model,
      messageId: answer.messageId,
      messageCreatedAt: answer.messageCreatedAt.toISOString(),
      runLabel: run.fromLabel,
    });
    if (outcome === 'applied') applied += 1;
    else leave(outcome);
  }

  return {
    status: 'ran',
    candidates: settling.length,
    applied,
    left,
    rules: [...reports.values()].sort(
      (a, b) => a.trigger.localeCompare(b.trigger) || a.name.localeCompare(b.name),
    ),
  };
}

/** The scope's predicates, read off the ticket a label's row is on. */
function scopeOfLabel(scope: Scope): SQL[] {
  const where: SQL[] = [];
  if (scope.channels) where.push(inArray(conversations.channel, scope.channels));
  if (scope.since) where.push(gte(conversations.createdAt, scope.since));
  if (scope.until) where.push(lt(conversations.createdAt, scope.until));
  return where;
}

/**
 * One ticket filed, under its row lock, after asking again everything the
 * candidate query asked: a person may have filed it, or resolved it, since.
 */
async function fileTicket(
  conversationId: string,
  categoryId: string,
  detail: CategoryEventDetail,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        statusCategory: ticketStatuses.category,
        channel: conversations.channel,
        sourceSystem: conversations.sourceSystem,
        isSpam: conversations.isSpam,
        deletedAt: conversations.deletedAt,
        mergedIntoId: conversations.mergedIntoId,
        categoryId: conversations.categoryId,
        ownedByEvent,
        filedByJev,
      })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
      .where(eq(conversations.id, conversationId))
      .for('update', { of: conversations });
    if (!locked) return 'gone';
    const refusal = applyRefusal(locked);
    if (refusal) return refusal;

    // routing-result: no follow-up — the backfill labels a backlog and never
    // retargets it: no rule pass, no SLA policy chosen again, no router (plan
    // 4.1, "It fires nothing"). Its report names the rules filing would wake.
    const write = await setConversationCategoryOn(
      tx,
      conversationId,
      categoryId,
      { label: CATEGORY_AI_ACTOR },
      detail,
    );
    if (write.outcome === 'changed') return 'applied';
    if (write.outcome === 'retired_category' || write.outcome === 'unknown_category') {
      return 'category retired since';
    }
    return write.outcome === 'no_ticket' ? 'gone' : 'already filed';
  });
}
