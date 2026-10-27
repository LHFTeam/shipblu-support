import { UNKNOWN_CATEGORY_KEY } from '@/lib/categories/registry';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { CATEGORY_AI_ACTOR, type CategoryOutcome } from './decide';

/**
 * How Jev's category answers grade against what people chose
 * (`plans/ticket-category-routing.md`, 4.2), over rows `report.ts` has read for
 * one run label and one question.
 *
 * Pure, so every rule of the grading is a test rather than a query. Each rule
 * below closes a way the report could say Jev is better or worse than it is,
 * silently — and the report is what decides whether Jev routes tickets.
 *
 * - **One settling answer per ticket.** A ticket is graded on the answer that
 *   settled it: its earliest `applied` or `would_apply` row. Not on every
 *   answer, which would weigh a ticket by how many messages its customer sent,
 *   and not on the last, which is never the one that would have routed it.
 * - **Ground truth is a person's `category_changed`**, one naming an agent —
 *   never the column, which rules and forms also write, and on the merchant
 *   number those would inflate merchant precision. The latest such event is
 *   the label, so a person who corrected themselves is read at their answer.
 * - **A label given after Jev wrote is not ground truth.** Under `apply` a
 *   person who agrees with Jev changes nothing and leaves no event, so the only
 *   labels after a write are disagreements: graded, they would make every
 *   applied answer wrong. They are counted under "filed", where what they
 *   measure — how often a person moves what Jev filed — is the question.
 * - **The rules baseline is graded on its own terms, on the same tickets.** Its
 *   answer for a ticket is the first message whose text the detector maps to a
 *   category, in the window Jev was asked in (no further than a message the
 *   ticket was owned or capped at), so neither is charged with the other's
 *   window. Both are graded over the same labelled tickets, so the two
 *   precisions are comparable.
 * - **Unknown never settles**, so it is a share of answers, not a class.
 */

/** The outcomes that judged a message on Jev's answer: what a threshold could change. */
const JUDGED: ReadonlySet<CategoryOutcome> = new Set([
  'applied',
  'would_apply',
  'unknown',
  'below_threshold',
]);

/** The outcomes that settle a ticket, in any mode a label holds. */
const SETTLING: ReadonlySet<CategoryOutcome> = new Set(['applied', 'would_apply']);

/** Where a ticket left Jev's window: no later message on it was asked about. */
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
};

export type GradingInput = {
  runLabel: string;
  /** In message order within each ticket. */
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
  /** A person's label given before any Jev write: null key is "no category". */
  label: { key: string | null } | null;
  /** A person labelled the ticket, but after Jev wrote to it. */
  labelledAfterJev: boolean;
  /** Any person `category_changed` at all — what keeps a ticket out of the sample. */
  touchedByPerson: boolean;
  /** Jev's last write under this label, and the person's change after it, if any. */
  filed: { key: string | null; changedTo: { key: string | null } | null } | null;
  /** Jev wrote to the ticket under any label. */
  writtenByJev: boolean;
  /** The ticket's rows, for the threshold sweep. */
  runs: readonly GradingRun[];
};

export function ticketVerdicts(
  runLabel: string,
  runs: readonly GradingRun[],
  events: readonly GradingEvent[],
): TicketVerdict[] {
  const runsByTicket = groupBy(runs, (run) => run.conversationId);
  const eventsByTicket = groupBy(events, (event) => event.conversationId);

  return [...runsByTicket].map(([conversationId, ticketRuns]) => {
    const ticketEvents = eventsByTicket.get(conversationId) ?? [];
    const judged = ticketRuns.some((run) => JUDGED.has(run.outcome));
    const predicted = ticketRuns.filter((run) => run.predictedKey !== null);

    const settleIndex = ticketRuns.findIndex(
      (run) => SETTLING.has(run.outcome) && run.predictedKey !== null,
    );
    const settleRun = settleIndex === -1 ? null : ticketRuns[settleIndex]!;

    const people = ticketEvents.filter((event) => event.agentId !== null);
    const jev = ticketEvents.filter((event) => event.actorLabel === CATEGORY_AI_ACTOR);
    const lastPerson = people.at(-1) ?? null;
    const independent =
      lastPerson !== null && !jev.some((write) => write.createdAt < lastPerson.createdAt);

    const lastJev = jev.filter((write) => write.runLabel === runLabel).at(-1) ?? null;
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
      labelledAfterJev: lastPerson !== null && !independent,
      touchedByPerson: lastPerson !== null,
      filed: lastJev
        ? { key: lastJev.key, changedTo: changedAfter ? { key: changedAfter.key } : null }
        : null,
      writtenByJev: jev.length > 0,
      runs: ticketRuns,
    };
  });
}

/**
 * Why a ticket was never judged, most decisive first: owned is about the
 * ticket, settled-elsewhere about another question settling it — the only way a
 * label's question sees nothing but `after_settle` — and a failure about one
 * call.
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
 * before the ticket left Jev's window. `after_settle` messages count — Jev
 * stopped asking because it had an answer, and the rules, still without one,
 * would have kept reading.
 */
function baselineAnswer(runs: readonly GradingRun[]): string | null {
  for (const run of runs) {
    if (LEFT_THE_WINDOW.has(run.outcome)) return null;
    if (run.baselineKey !== null) return run.baselineKey;
  }
  return null;
}

/**
 * What a ticket would have settled on under another threshold, from the
 * answers its rows hold.
 *
 * Exact at or below the threshold the rows were decided against: every message
 * up to the settle was asked, so a lower bar settles on one of them. Above it,
 * a settle the higher bar refuses leaves the ticket on messages Jev was never
 * asked about (`after_settle`), and those are `unasked` rather than
 * unsettled — nobody knows what Jev would have said.
 */
export function settleAt(
  runs: readonly GradingRun[],
  threshold: number,
): { kind: 'settled'; key: string } | { kind: 'unasked' } | { kind: 'none' } {
  for (const run of runs) {
    if (LEFT_THE_WINDOW.has(run.outcome)) return { kind: 'none' };
    if (run.outcome === 'after_settle') return { kind: 'unasked' };
    if (!JUDGED.has(run.outcome)) continue;
    const key = run.predictedKey;
    if (key === null || key === UNKNOWN_CATEGORY_KEY) continue;
    // A missing probability never settles, as `decide` reads it.
    if (run.probability !== null && run.probability >= threshold) {
      return { kind: 'settled', key };
    }
  }
  return { kind: 'none' };
}

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
  /** Judged tickets with a person's label given before any Jev write. */
  labelled: number;
  /** Of those, the ones Jev settled — precision's denominator. */
  settledLabelled: number;
  right: number;
  /** Of the labelled, the ones the rules had an answer for, and how many were right. */
  rulesAnswered: number;
  rulesRight: number;
  /** Settled tickets the rules also answered, and how many the two agree on. */
  comparable: number;
  agree: number;
};

export type CategoryGrade = {
  key: string;
  /** Judged tickets Jev settled as this. */
  settled: number;
  /** Of those, labelled — precision's denominator — and labelled this. */
  graded: number;
  right: number;
  /** Labelled tickets whose label is this — recall's denominator. */
  labelled: number;
  rulesGraded: number;
  rulesRight: number;
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
  graded: number;
  right: number;
  byCategory: { key: string; graded: number; right: number }[];
};

export type FiledRow = {
  /** What Jev filed; null when it cleared a category, which it never does today. */
  key: string | null;
  filed: number;
  changed: number;
  changedTo: { key: string | null; count: number }[];
};

export type SampleStratum = {
  /** Jev's settling answer; null for tickets it never settled. */
  key: string | null;
  /** Tickets in this stratum already labelled. */
  labelled: number;
  /** Tickets still waiting for a label. */
  waiting: number;
};

/** A ticket offered for labelling, with nothing on it that says what Jev chose. */
export type ToLabel = { conversationId: string; number: number; channel: ConversationChannel };

export type Grading = {
  total: Slice;
  slices: Slice[];
  categories: CategoryGrade[];
  confusion: ConfusionCell[];
  sweep: SweepRow[];
  filed: FiledRow[];
  sample: SampleStratum[];
  /** Every stratum's page of tickets, merged into one list in id order. */
  toLabel: ToLabel[];
  outOfPlay: Record<OutOfPlay, number>;
  labelledAfterJev: number;
};

export function grade(input: GradingInput): Grading {
  const verdicts = ticketVerdicts(input.runLabel, input.runs, input.events);
  const keys = orderedKeys(input.categoryKeys, verdicts);
  const judged = verdicts.filter((verdict) => verdict.judged);
  const labelled = judged.filter((verdict) => verdict.label !== null);

  const channels = [...new Set(verdicts.map((verdict) => verdict.channel))];
  const slices = channels
    .map((channel) =>
      slice(
        channel,
        verdicts.filter((verdict) => verdict.channel === channel),
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

  return {
    total: slice(null, verdicts),
    slices,
    categories: keys.map((key) => ({
      key,
      settled: judged.filter((verdict) => verdict.settle?.key === key).length,
      graded: labelled.filter((verdict) => verdict.settle?.key === key).length,
      right: labelled.filter((verdict) => verdict.settle?.key === key && verdict.label!.key === key)
        .length,
      labelled: labelled.filter((verdict) => verdict.label!.key === key).length,
      rulesGraded: labelled.filter((verdict) => verdict.baseline === key).length,
      rulesRight: labelled.filter(
        (verdict) => verdict.baseline === key && verdict.label!.key === key,
      ).length,
    })),
    confusion: confusion(labelled),
    sweep: sweep(judged, keys, input),
    filed: filed(verdicts, keys),
    sample: strata.map(({ key, labelled, waiting }) => ({ key, labelled, waiting })),
    toLabel: strata.flatMap((stratum) => stratum.tickets).sort(byId),
    outOfPlay: outOfPlayCounts,
    labelledAfterJev: judged.filter((verdict) => verdict.labelledAfterJev).length,
  };
}

function slice(channel: ConversationChannel | null, verdicts: readonly TicketVerdict[]): Slice {
  const judged = verdicts.filter((verdict) => verdict.judged);
  const settled = judged.filter((verdict) => verdict.settle !== null);
  const labelled = judged.filter((verdict) => verdict.label !== null);
  const settledLabelled = labelled.filter((verdict) => verdict.settle !== null);
  const rulesAnswered = labelled.filter((verdict) => verdict.baseline !== null);
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
    settledLabelled: settledLabelled.length,
    right: settledLabelled.filter((verdict) => verdict.settle!.key === verdict.label!.key).length,
    rulesAnswered: rulesAnswered.length,
    rulesRight: rulesAnswered.filter((verdict) => verdict.baseline === verdict.label!.key).length,
    comparable: comparable.length,
    agree: comparable.filter((verdict) => verdict.baseline === verdict.settle!.key).length,
  };
}

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

function sweep(
  judged: readonly TicketVerdict[],
  keys: readonly string[],
  input: GradingInput,
): SweepRow[] {
  const recorded = new Set(
    input.runs
      .filter((run) => JUDGED.has(run.outcome) && run.minProbability !== null)
      .map((run) => run.minProbability!),
  );
  const thresholds = [...new Set([...input.thresholds, ...recorded])].sort((a, b) => a - b);

  return thresholds.map((threshold) => {
    const byKey = new Map(keys.map((key) => [key, { key, graded: 0, right: 0 }]));
    const row: SweepRow = {
      threshold,
      inForce: recorded.has(threshold),
      settled: 0,
      unasked: 0,
      graded: 0,
      right: 0,
      byCategory: [...byKey.values()],
    };
    for (const verdict of judged) {
      const answer = settleAt(verdict.runs, threshold);
      if (answer.kind === 'unasked') row.unasked += 1;
      if (answer.kind !== 'settled') continue;
      row.settled += 1;
      if (!verdict.label) continue;
      const entry = byKey.get(answer.key)!;
      row.graded += 1;
      entry.graded += 1;
      if (answer.key === verdict.label.key) {
        row.right += 1;
        entry.right += 1;
      }
    }
    return row;
  });
}

/**
 * Jev's writes under this label, and how many a person moved since. A person
 * who changed it and changed it back has agreed with Jev in the end, so only a
 * last word that differs counts as a change.
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
 * a ticket changes nothing, and leaves no label. In id order, which for a
 * random uuid is a fixed random order — the same tickets on every load until
 * they are labelled, and no bias to the newest or the oldest.
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
      .filter(
        (verdict) =>
          !verdict.touchedByPerson &&
          !verdict.writtenByJev &&
          tickets.get(verdict.conversationId)?.labellable === true,
      )
      .sort(byId);
    return [
      {
        key,
        labelled: members.filter((verdict) => verdict.label !== null).length,
        waiting: waiting.length,
        tickets: waiting.slice(0, SAMPLE_SIZE).map((verdict) => ({
          conversationId: verdict.conversationId,
          number: tickets.get(verdict.conversationId)!.number,
          channel: verdict.channel,
        })),
      },
    ];
  });
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
