import { UNKNOWN_CATEGORY_KEY } from '@/lib/categories/registry';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import {
  CATEGORY_AI_ACTOR,
  CLASSIFIED_MESSAGE_CAP,
  arrivedBefore,
  type CategoryOutcome,
} from './decide';

/**
 * How Jev's category answers grade against what people chose
 * (`plans/ticket-category-routing.md`, 4.2), over rows `report.ts` has read for
 * one run label, one question and one mode.
 *
 * Pure, so every rule of the grading is a test rather than a query. Each rule
 * below closes a way the report could say Jev is better or worse than it is,
 * silently — and the report is what decides whether Jev routes tickets.
 *
 * - **One settling answer per ticket.** A ticket is graded on the answer that
 *   settled it: its earliest `applied` or `would_apply` row, in the order the
 *   live job and the backfill judge messages (`arrivedBefore`: the instant,
 *   then the message id). Not on every answer, which would weigh a ticket by
 *   how many messages its customer sent, and not on the last, which is never
 *   the one that would have routed it.
 * - **Ground truth is a person's `category_changed`**, one naming an agent —
 *   never the column, which rules and forms also write, and on the merchant
 *   number those would inflate merchant precision. The latest such event is
 *   the label, so a person who corrected themselves is read at their answer.
 * - **A label given after anything else wrote the category is not ground
 *   truth.** A person who agrees with what Jev or a rule filed changes nothing
 *   and leaves no event, so the only labels after a write are disagreements:
 *   graded, they would make every such answer wrong. They are counted apart,
 *   and Jev's own filings under "filed", where what they measure — how often a
 *   person moves what Jev filed — is the question.
 * - **The sample is stratified, so its rates are weighted.** The labelling list
 *   draws the same number of tickets from each of Jev's answers, so the rare
 *   one is labelled at a far higher rate than the common one. Precision within
 *   one answer is a rate over one stratum and needs nothing; every rate that
 *   mixes strata — recall, the overall rate, the rules', the sweep's — weighs
 *   each labelled ticket by how many judged tickets of its stratum it stands
 *   for (`Estimate`), so it estimates the run rather than the sample. Labels
 *   given in ordinary work are weighed the same way: within a stratum they are
 *   the evidence there is.
 * - **The rules baseline is graded on its own terms, on the same tickets.** Its
 *   answer for a ticket is the first message whose text the detector maps to a
 *   category, inside the window Jev had: at most five messages, and no further
 *   than one the ticket was owned or capped at — so neither is charged with the
 *   other's window.
 * - **Unknown never settles**, so it is a share of answers, not a class.
 */

/** The outcomes that judged a message on Jev's answer: what a threshold could change. */
const JUDGED: ReadonlySet<CategoryOutcome> = new Set([
  'applied',
  'would_apply',
  'unknown',
  'below_threshold',
]);

/** The outcomes that settle a ticket, in any mode a view holds. */
const SETTLING: ReadonlySet<CategoryOutcome> = new Set(['applied', 'would_apply']);

/** Where a ticket had left Jev's window when that message's job ran. */
const LEFT_THE_WINDOW: ReadonlySet<CategoryOutcome> = new Set(['owned', 'capped']);

/** Tickets offered for labelling in each stratum, at most. */
export const SAMPLE_SIZE = 10;

/**
 * Labelled tickets a class needs before its precision is read as a criterion —
 * the plan's proposed bar for moving to `apply` (4.2, step 3).
 */
export const LABELS_WANTED = 30;

/** One run row, as the report reads it. */
export type GradingRun = {
  conversationId: string;
  /** Null once the message was deleted; the row stays, frozen at its instant. */
  messageId: string | null;
  channel: ConversationChannel;
  messageCreatedAt: Date;
  outcome: CategoryOutcome;
  predictedKey: string | null;
  probability: number | null;
  /** The threshold the outcome was decided against. */
  minProbability: number | null;
  baselineKey: string | null;
};

/** One `category_changed` event on a ticket the runs name. */
export type GradingEvent = {
  conversationId: string;
  createdAt: Date;
  /** The agent who wrote it, or null for a rule, a form, Jev — or a deleted agent. */
  agentId: string | null;
  actorLabel: string | null;
  /** The category key the event set, or null when it cleared the category. */
  key: string | null;
  /** The run label a Jev write names. */
  runLabel: string | null;
  /** The message a Jev write answered. */
  messageId: string | null;
};

/** What the sample needs to know of a ticket. */
export type GradingTicket = {
  number: number;
  /**
   * A ticket a supervisor can label: not deleted, not spam, not merged, and
   * with no category now. Choosing the category a ticket already has writes
   * nothing, so on a ticket a rule or Jev filed, agreeing leaves no label.
   */
  labellable: boolean;
  /**
   * Open or pending and nobody has answered it: Jev may yet be asked about its
   * next message. Labelling it would make every later message owned.
   */
  windowOpen: boolean;
};

export type GradingInput = {
  runLabel: string;
  runs: readonly GradingRun[];
  /** In the order they were written within each ticket. */
  events: readonly GradingEvent[];
  tickets: ReadonlyMap<string, GradingTicket>;
  /** The registry's keys in the admin's order; a key seen and not here follows them. */
  categoryKeys: readonly string[];
  /** Thresholds to sweep; the ones the rows were decided against are added to them. */
  thresholds: readonly number[];
};

/** Why a ticket with rows was never judged on an answer. */
export type OutOfPlay = 'owned' | 'settled_elsewhere' | 'capped' | 'failed';

/** One ticket as the grading sees it. */
export type TicketVerdict = {
  conversationId: string;
  channel: ConversationChannel;
  /** At least one message was judged on Jev's answer. */
  judged: boolean;
  outOfPlay: OutOfPlay | null;
  /** Rows carrying a prediction, and those predicting `unknown`. */
  answers: number;
  unknowns: number;
  settle: { key: string; onFirstMessage: boolean } | null;
  /** The rules' answer for the ticket, or null when the detector mapped nothing. */
  baseline: string | null;
  /** A person's label given before anything else wrote: null key is "no category". */
  label: { key: string | null } | null;
  /** A person labelled the ticket, but after Jev, a rule or a form wrote to it. */
  labelledAfterWrite: boolean;
  /** Any person `category_changed` at all — what keeps a ticket out of the sample. */
  touchedByPerson: boolean;
  /** Jev's last write answering one of these rows, and the person's change after it. */
  filed: { key: string | null; changedTo: { key: string | null } | null } | null;
  /** Jev wrote to the ticket under any label. */
  writtenByJev: boolean;
  /** The ticket's rows in the order they are judged, for the threshold sweep. */
  runs: readonly GradingRun[];
};

export function ticketVerdicts(
  runLabel: string,
  runs: readonly GradingRun[],
  events: readonly GradingEvent[],
): TicketVerdict[] {
  const runsByTicket = groupBy(runs, (run) => run.conversationId);
  const eventsByTicket = groupBy(events, (event) => event.conversationId);

  return [...runsByTicket].map(([conversationId, unordered]) => {
    const ticketRuns = [...unordered].sort(inJudgedOrder);
    const ticketEvents = eventsByTicket.get(conversationId) ?? [];
    const judged = ticketRuns.some((run) => JUDGED.has(run.outcome));
    const predicted = ticketRuns.filter((run) => run.predictedKey !== null);

    const settleIndex = ticketRuns.findIndex(
      (run) => SETTLING.has(run.outcome) && run.predictedKey !== null,
    );
    const settleRun = settleIndex === -1 ? null : ticketRuns[settleIndex]!;

    const people = ticketEvents.filter((event) => event.agentId !== null);
    const written = ticketEvents.filter((event) => event.agentId === null);
    const jev = written.filter((event) => event.actorLabel === CATEGORY_AI_ACTOR);
    const lastPerson = people.at(-1) ?? null;
    const independent =
      lastPerson !== null && !written.some((write) => write.createdAt < lastPerson.createdAt);

    // A write under another label or another question is that run's filing.
    const answered = new Set(ticketRuns.map((run) => run.messageId).filter(Boolean));
    const lastJev =
      jev
        .filter(
          (write) =>
            write.runLabel === runLabel &&
            write.messageId !== null &&
            answered.has(write.messageId),
        )
        .at(-1) ?? null;
    const changedAfter = lastJev
      ? (people.filter((event) => event.createdAt > lastJev.createdAt).at(-1) ?? null)
      : null;

    return {
      conversationId,
      channel: ticketRuns[0]!.channel,
      judged,
      outOfPlay: judged ? null : outOfPlay(ticketRuns),
      answers: predicted.length,
      unknowns: predicted.filter((run) => run.predictedKey === UNKNOWN_CATEGORY_KEY).length,
      settle: settleRun
        ? { key: settleRun.predictedKey!, onFirstMessage: settleIndex === 0 }
        : null,
      baseline: baselineAnswer(ticketRuns),
      label: independent ? { key: lastPerson.key } : null,
      labelledAfterWrite: lastPerson !== null && !independent,
      touchedByPerson: lastPerson !== null,
      filed: lastJev
        ? { key: lastJev.key, changedTo: changedAfter ? { key: changedAfter.key } : null }
        : null,
      writtenByJev: jev.length > 0,
      runs: ticketRuns,
    };
  });
}

/** The order the live job and the backfill judge a ticket's messages in. */
function inJudgedOrder(a: GradingRun, b: GradingRun): number {
  if (b.messageId === null) {
    // `arrivedBefore` wants an id on its second side; a tie of two deleted
    // messages is no order at all.
    const byTime = a.messageCreatedAt.getTime() - b.messageCreatedAt.getTime();
    return byTime !== 0 || a.messageId === null ? byTime : -1;
  }
  return arrivedBefore(
    { createdAt: a.messageCreatedAt, messageId: a.messageId },
    { createdAt: b.messageCreatedAt, messageId: b.messageId },
  );
}

/**
 * Why a ticket was never judged, most decisive first: owned is about the
 * ticket; settled-elsewhere means an earlier message settled it under another
 * question, or a backfill's filing did; a failure is about one call.
 */
function outOfPlay(runs: readonly GradingRun[]): OutOfPlay {
  const outcomes = new Set(runs.map((run) => run.outcome));
  if (outcomes.has('owned')) return 'owned';
  if (outcomes.has('after_settle')) return 'settled_elsewhere';
  if (outcomes.has('capped')) return 'capped';
  return 'failed';
}

/**
 * The rules' answer: the first message the detector mapped to a category,
 * inside the window Jev had — at most the five messages Jev could have been
 * asked about, and none from the one the ticket was owned or capped at.
 * `after_settle` messages count within that: Jev stopped asking because it
 * had an answer, and the rules, still without one, would have kept reading.
 */
function baselineAnswer(runs: readonly GradingRun[]): string | null {
  let read = 0;
  for (const run of runs) {
    if (LEFT_THE_WINDOW.has(run.outcome) || read >= CLASSIFIED_MESSAGE_CAP) return null;
    read += 1;
    if (run.baselineKey !== null) return run.baselineKey;
  }
  return null;
}

/**
 * What a ticket would have settled on under another threshold, from the
 * answers its rows hold.
 *
 * Exact at or below the lowest threshold the rows were decided against: every
 * message up to the settle was asked, so a lower bar settles on one of them.
 * Above it, a settle the higher bar refuses leaves the ticket on messages Jev
 * was never asked about (`after_settle` with no answer), and those are
 * `unasked` rather than unsettled — nobody knows what Jev would have said.
 *
 * Any row with an answer is read, whatever its outcome: an `after_settle` row
 * can hold one when its job asked before the settle landed. The cap is counted
 * as the live job counts it, every answered row. An `owned` or `capped` row is
 * passed over rather than taken as the end: jobs run in no order, so one can
 * sit before a message that was still asked.
 */
export function settleAt(
  runs: readonly GradingRun[],
  threshold: number,
): { kind: 'settled'; key: string } | { kind: 'unasked' } | { kind: 'none' } {
  let asked = 0;
  for (const run of runs) {
    const answered = run.predictedKey !== null && run.outcome !== 'failed';
    if (LEFT_THE_WINDOW.has(run.outcome)) {
      if (answered) asked += 1;
      continue;
    }
    // Five asked: the next message would have been capped, not asked.
    if (asked >= CLASSIFIED_MESSAGE_CAP) return { kind: 'none' };
    if (!answered) {
      if (run.outcome === 'after_settle') return { kind: 'unasked' };
      continue;
    }
    asked += 1;
    const key = run.predictedKey!;
    if (key === UNKNOWN_CATEGORY_KEY) continue;
    // A missing probability never settles, as `decide` reads it.
    if (run.probability !== null && run.probability >= threshold) {
      return { kind: 'settled', key };
    }
  }
  return { kind: 'none' };
}

/**
 * A rate over labelled tickets: how many of how many in the sample, and the
 * rate those stand for in the run, each ticket weighed by its stratum (the
 * module's header). Equal when every ticket is from one stratum.
 */
export type Estimate = { right: number; of: number; rate: number | null };

/** Every figure the page draws, per channel and in total. */
export type Slice = {
  /** Null for every channel together. */
  channel: ConversationChannel | null;
  tickets: number;
  judged: number;
  settled: number;
  settledOnFirst: number;
  answers: number;
  unknowns: number;
  /** Judged tickets with a person's label given before anything else wrote. */
  labelled: number;
  /** Jev's settling answer against the label, over the labelled tickets it settled. */
  jev: Estimate;
  /** The rules' answer against the label, over the labelled tickets they answered. */
  rules: Estimate;
  /** Settled tickets the rules also answered, and how many the two agree on. */
  comparable: number;
  agree: number;
};

export type CategoryGrade = {
  key: string;
  /** Judged tickets Jev settled as this. */
  settled: number;
  /** Of the labelled tickets Jev settled as this, labelled this. One stratum: unweighted. */
  precision: Estimate;
  /** Of the labelled tickets labelled this, settled as this. */
  recall: Estimate;
  rulesPrecision: Estimate;
  rulesRecall: Estimate;
};

export type ConfusionCell = {
  /** The person's label; null is "no category". */
  label: string | null;
  /** Jev's settling answer; null is "never settled". */
  settled: string | null;
  count: number;
};

export type SweepRow = {
  threshold: number;
  /** A threshold some of the rows were decided against. */
  inForce: boolean;
  settled: number;
  /** Tickets whose answer at this bar is on a message Jev was never asked about. */
  unasked: number;
  jev: Estimate;
  byCategory: { key: string; precision: Estimate }[];
};

export type FiledRow = {
  /** What Jev filed; null when it cleared a category, which it never does today. */
  key: string | null;
  filed: number;
  changed: number;
  changedTo: { key: string | null; count: number }[];
};

/**
 * One of Jev's answers the sample is drawn by, and how many of its tickets
 * are labelled. Not how many wait: beside one list of tickets, a stratum that
 * alone has tickets waiting names what Jev said about every one of them.
 */
export type SampleStratum = {
  /** Jev's settling answer; null for tickets it never settled. */
  key: string | null;
  labelled: number;
};

/** A ticket offered for labelling, with nothing on it that says what Jev chose. */
export type ToLabel = { conversationId: string; number: number; channel: ConversationChannel };

export type Grading = {
  total: Slice;
  slices: Slice[];
  categories: CategoryGrade[];
  confusion: ConfusionCell[];
  sweep: SweepRow[];
  /** The thresholds the run's answers were decided against, lowest first. */
  thresholdsInForce: number[];
  filed: FiledRow[];
  sample: SampleStratum[];
  /** Every stratum's page of tickets, merged into one list in id order. */
  toLabel: ToLabel[];
  outOfPlay: Record<OutOfPlay, number>;
  labelledAfterWrite: number;
};

export function grade(input: GradingInput): Grading {
  const verdicts = ticketVerdicts(input.runLabel, input.runs, input.events);
  const keys = orderedKeys(input.categoryKeys, verdicts);
  const judged = verdicts.filter((verdict) => verdict.judged);
  const labelled = judged.filter((verdict) => verdict.label !== null);
  const weigh = weights(judged);
  const estimate = (items: readonly TicketVerdict[], hit: (verdict: TicketVerdict) => boolean) =>
    estimated(items, hit, weigh);

  const channels = [...new Set(verdicts.map((verdict) => verdict.channel))];
  const slices = channels
    .map((channel) =>
      slice(
        channel,
        verdicts.filter((verdict) => verdict.channel === channel),
        estimate,
      ),
    )
    .sort((a, b) => b.tickets - a.tickets || a.channel!.localeCompare(b.channel!));

  const outOfPlayCounts: Record<OutOfPlay, number> = {
    owned: 0,
    settled_elsewhere: 0,
    capped: 0,
    failed: 0,
  };
  for (const verdict of verdicts) {
    if (verdict.outOfPlay) outOfPlayCounts[verdict.outOfPlay] += 1;
  }
  const strata = sample(judged, keys, input.tickets);
  const inForce = [
    ...new Set(
      input.runs
        .filter((run) => JUDGED.has(run.outcome) && run.minProbability !== null)
        .map((run) => run.minProbability!),
    ),
  ].sort((a, b) => a - b);

  return {
    total: slice(null, verdicts, estimate),
    slices,
    categories: keys.map((key) => {
      const labelledThis = labelled.filter((verdict) => verdict.label!.key === key);
      return {
        key,
        settled: judged.filter((verdict) => verdict.settle?.key === key).length,
        precision: estimate(
          labelled.filter((verdict) => verdict.settle?.key === key),
          (verdict) => verdict.label!.key === key,
        ),
        recall: estimate(labelledThis, (verdict) => verdict.settle?.key === key),
        rulesPrecision: estimate(
          labelled.filter((verdict) => verdict.baseline === key),
          (verdict) => verdict.label!.key === key,
        ),
        rulesRecall: estimate(labelledThis, (verdict) => verdict.baseline === key),
      };
    }),
    confusion: confusion(labelled),
    sweep: sweep(judged, labelled, keys, input.thresholds, inForce, estimate),
    thresholdsInForce: inForce,
    filed: filed(verdicts, keys),
    sample: strata.map(({ key, labelled }) => ({ key, labelled })),
    toLabel: strata.flatMap((stratum) => stratum.tickets).sort(byId),
    outOfPlay: outOfPlayCounts,
    labelledAfterWrite: judged.filter((verdict) => verdict.labelledAfterWrite).length,
  };
}

/**
 * How many judged tickets each labelled one stands for: its stratum's size
 * over the labels the stratum has, the stratum being Jev's settling answer at
 * the threshold in force, or none.
 */
function weights(judged: readonly TicketVerdict[]): (verdict: TicketVerdict) => number {
  const size = new Map<string | null, number>();
  const labels = new Map<string | null, number>();
  for (const verdict of judged) {
    const stratum = verdict.settle?.key ?? null;
    size.set(stratum, (size.get(stratum) ?? 0) + 1);
    if (verdict.label) labels.set(stratum, (labels.get(stratum) ?? 0) + 1);
  }
  return (verdict) => {
    const stratum = verdict.settle?.key ?? null;
    return (size.get(stratum) ?? 0) / (labels.get(stratum) ?? 1);
  };
}

function estimated(
  items: readonly TicketVerdict[],
  hit: (verdict: TicketVerdict) => boolean,
  weigh: (verdict: TicketVerdict) => number,
): Estimate {
  let right = 0;
  let total = 0;
  let hits = 0;
  for (const verdict of items) {
    const weight = weigh(verdict);
    total += weight;
    if (hit(verdict)) {
      right += 1;
      hits += weight;
    }
  }
  return { right, of: items.length, rate: total > 0 ? hits / total : null };
}

function slice(
  channel: ConversationChannel | null,
  verdicts: readonly TicketVerdict[],
  estimate: (items: readonly TicketVerdict[], hit: (verdict: TicketVerdict) => boolean) => Estimate,
): Slice {
  const judged = verdicts.filter((verdict) => verdict.judged);
  const settled = judged.filter((verdict) => verdict.settle !== null);
  const labelled = judged.filter((verdict) => verdict.label !== null);
  const comparable = settled.filter((verdict) => verdict.baseline !== null);

  return {
    channel,
    tickets: verdicts.length,
    judged: judged.length,
    settled: settled.length,
    settledOnFirst: settled.filter((verdict) => verdict.settle!.onFirstMessage).length,
    answers: sum(verdicts, (verdict) => verdict.answers),
    unknowns: sum(verdicts, (verdict) => verdict.unknowns),
    labelled: labelled.length,
    jev: estimate(
      labelled.filter((verdict) => verdict.settle !== null),
      (verdict) => verdict.settle!.key === verdict.label!.key,
    ),
    rules: estimate(
      labelled.filter((verdict) => verdict.baseline !== null),
      (verdict) => verdict.baseline === verdict.label!.key,
    ),
    comparable: comparable.length,
    agree: comparable.filter((verdict) => verdict.baseline === verdict.settle!.key).length,
  };
}

/** Counts of the labelled sample as drawn, unweighted: a table of tickets, not of rates. */
function confusion(labelled: readonly TicketVerdict[]): ConfusionCell[] {
  const cells = new Map<string, ConfusionCell>();
  for (const verdict of labelled) {
    const label = verdict.label!.key;
    const settled = verdict.settle?.key ?? null;
    const id = JSON.stringify([label, settled]);
    const cell = cells.get(id) ?? { label, settled, count: 0 };
    cell.count += 1;
    cells.set(id, cell);
  }
  return [...cells.values()];
}

/**
 * The run re-settled at each threshold. The weights stay those of the
 * threshold in force, which is how the sample was drawn: a ticket that would
 * settle at a lower bar is the same labelled ticket, standing for the same
 * share of the run.
 */
function sweep(
  judged: readonly TicketVerdict[],
  labelled: readonly TicketVerdict[],
  keys: readonly string[],
  asked: readonly number[],
  inForce: readonly number[],
  estimate: (items: readonly TicketVerdict[], hit: (verdict: TicketVerdict) => boolean) => Estimate,
): SweepRow[] {
  const thresholds = [...new Set([...asked, ...inForce])].sort((a, b) => a - b);

  return thresholds.map((threshold) => {
    const answers = new Map<TicketVerdict, string>();
    let settled = 0;
    let unasked = 0;
    for (const verdict of judged) {
      const answer = settleAt(verdict.runs, threshold);
      if (answer.kind === 'unasked') unasked += 1;
      if (answer.kind !== 'settled') continue;
      settled += 1;
      answers.set(verdict, answer.key);
    }
    const graded = labelled.filter((verdict) => answers.has(verdict));
    return {
      threshold,
      inForce: inForce.includes(threshold),
      settled,
      unasked,
      jev: estimate(graded, (verdict) => answers.get(verdict) === verdict.label!.key),
      byCategory: keys.map((key) => ({
        key,
        precision: estimate(
          graded.filter((verdict) => answers.get(verdict) === key),
          (verdict) => verdict.label!.key === key,
        ),
      })),
    };
  });
}

/**
 * Jev's writes answering this view's rows, and how many a person moved since.
 * A person who changed it and changed it back has agreed with Jev in the end,
 * so only a last word that differs counts as a change.
 */
function filed(verdicts: readonly TicketVerdict[], keys: readonly string[]): FiledRow[] {
  const rows = new Map<string | null, FiledRow>();
  for (const verdict of verdicts) {
    if (!verdict.filed) continue;
    const { key, changedTo } = verdict.filed;
    const row = rows.get(key) ?? { key, filed: 0, changed: 0, changedTo: [] };
    row.filed += 1;
    if (changedTo && changedTo.key !== key) {
      row.changed += 1;
      const to = row.changedTo.find((entry) => entry.key === changedTo.key);
      if (to) to.count += 1;
      else row.changedTo.push({ key: changedTo.key, count: 1 });
    }
    rows.set(key, row);
  }
  for (const row of rows.values()) row.changedTo.sort((a, b) => b.count - a.count);
  return [...rows.values()].sort((a, b) => rank(keys, a.key) - rank(keys, b.key));
}

/**
 * Tickets for a supervisor to label, stratified by Jev's settling answer so the
 * rare class is represented, and a stratum of tickets it never settled so
 * recall has misses to count.
 *
 * The strata are how the tickets are chosen, never how they are shown: `grade`
 * merges them into one list, because a supervisor told "Jev said sales" before
 * opening a ticket is being asked to agree, and the label is then Jev's answer
 * read back.
 *
 * Only tickets nobody has labelled, Jev never wrote to and nothing has filed
 * (`GradingTicket.labellable`): a person who agrees with a category already on
 * a ticket changes nothing, and leaves no label. And a ticket Jev never settled
 * only once its window has closed — answered, resolved, or asked five times —
 * since labelling one Jev may still be asked about would turn its next message
 * into `owned` and the ticket into a miss it never had the chance to avoid.
 * In id order, which for a random uuid is a fixed random order — the same
 * tickets on every load until they are labelled, and no bias to the newest or
 * the oldest.
 */
function sample(
  judged: readonly TicketVerdict[],
  keys: readonly string[],
  tickets: ReadonlyMap<string, GradingTicket>,
): (SampleStratum & { tickets: ToLabel[] })[] {
  return [...keys, null].flatMap((key) => {
    const members = judged.filter((verdict) => (verdict.settle?.key ?? null) === key);
    if (members.length === 0) return [];
    const waiting = members
      .filter((verdict) => {
        const ticket = tickets.get(verdict.conversationId);
        if (!ticket?.labellable || verdict.touchedByPerson || verdict.writtenByJev) return false;
        return key !== null || !ticket.windowOpen || askedOf(verdict) >= CLASSIFIED_MESSAGE_CAP;
      })
      .sort(byId);
    return [
      {
        key,
        labelled: members.filter((verdict) => verdict.label !== null).length,
        tickets: waiting.slice(0, SAMPLE_SIZE).map((verdict) => ({
          conversationId: verdict.conversationId,
          number: tickets.get(verdict.conversationId)!.number,
          channel: verdict.channel,
        })),
      },
    ];
  });
}

/** Messages on the ticket Jev answered, as the cap counts them. */
function askedOf(verdict: TicketVerdict): number {
  return verdict.runs.filter((run) => run.predictedKey !== null && run.outcome !== 'failed').length;
}

function byId(a: { conversationId: string }, b: { conversationId: string }): number {
  return a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0;
}

/** A key's place in the registry's order; null — no category — after every key. */
function rank(keys: readonly string[], key: string | null): number {
  if (key === null) return keys.length + 1;
  const at = keys.indexOf(key);
  return at === -1 ? keys.length : at;
}

/** The registry's order, then any other key a row or a label names, alphabetically. */
function orderedKeys(registry: readonly string[], verdicts: readonly TicketVerdict[]): string[] {
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    const answered = verdict.runs.map((run) => run.predictedKey);
    for (const key of [...answered, verdict.baseline, verdict.label?.key, verdict.filed?.key]) {
      if (key && key !== UNKNOWN_CATEGORY_KEY) seen.add(key);
    }
  }
  const extra = [...seen].filter((key) => !registry.includes(key)).sort();
  return [...registry, ...extra];
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
