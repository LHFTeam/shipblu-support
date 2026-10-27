import { describe, expect, it } from 'vitest';
import type { CategoryOutcome } from './decide';
import {
  SAMPLE_SIZE,
  grade,
  settleAt,
  ticketVerdicts,
  type GradingEvent,
  type GradingInput,
  type GradingRun,
  type GradingTicket,
} from './grade';

/**
 * The grading rules, one case each: what settles a ticket, what counts as a
 * person's label, how the rules baseline is read, what a threshold would have
 * done, and which tickets are offered for labelling. Each is a way the report
 * could say Jev is better or worse than it is, and nothing on the page would
 * show it.
 */

const LABEL = 'live';
const KEYS = ['sales', 'customer_support', 'merchant_support', 'courier_jobs'];
const START = Date.parse('2026-10-01T09:00:00Z');
const minute = (n: number) => new Date(START + n * 60_000);

function run(
  conversationId: string,
  at: number,
  outcome: CategoryOutcome,
  predictedKey: string | null = null,
  probability: number | null = null,
  extra: Partial<GradingRun> = {},
): GradingRun {
  return {
    conversationId,
    channel: 'whatsapp',
    messageCreatedAt: minute(at),
    outcome,
    predictedKey,
    probability,
    minProbability: 0.6,
    baselineKey: null,
    ...extra,
  };
}

function person(conversationId: string, at: number, key: string | null): GradingEvent {
  return {
    conversationId,
    createdAt: minute(at),
    agentId: 'agent-1',
    actorLabel: null,
    key,
    runLabel: null,
  };
}

function jevWrite(conversationId: string, at: number, key: string, runLabel = LABEL): GradingEvent {
  return {
    conversationId,
    createdAt: minute(at),
    agentId: null,
    actorLabel: 'jev:category',
    key,
    runLabel,
  };
}

function rule(conversationId: string, at: number, key: string): GradingEvent {
  return {
    conversationId,
    createdAt: minute(at),
    agentId: null,
    actorLabel: 'automation:file-sales',
    key,
    runLabel: null,
  };
}

function input(
  runs: GradingRun[],
  events: GradingEvent[] = [],
  extra: Partial<GradingInput> = {},
): GradingInput {
  const tickets = new Map<string, GradingTicket>();
  for (const [index, id] of [...new Set(runs.map((each) => each.conversationId))].entries()) {
    tickets.set(id, { number: 100 + index, labellable: true });
  }
  return { runLabel: LABEL, runs, events, tickets, categoryKeys: KEYS, thresholds: [], ...extra };
}

function verdict(runs: GradingRun[], events: GradingEvent[] = []) {
  const [only] = ticketVerdicts(LABEL, runs, events);
  return only!;
}

describe('the settling answer', () => {
  it('is the earliest applied or would_apply, not the last', () => {
    const graded = verdict([
      run('t', 0, 'below_threshold', 'customer_support', 0.4),
      run('t', 1, 'would_apply', 'sales', 0.8),
      run('t', 2, 'after_settle'),
      run('t', 3, 'would_apply', 'courier_jobs', 0.9),
    ]);
    expect(graded.settle).toEqual({ key: 'sales', onFirstMessage: false });
  });

  it('marks a settle on the ticket first message', () => {
    const graded = verdict([run('t', 0, 'applied', 'sales', 0.9), run('t', 1, 'after_settle')]);
    expect(graded.settle).toEqual({ key: 'sales', onFirstMessage: true });
  });

  it('is never unknown, however sure Jev was', () => {
    const graded = verdict([
      run('t', 0, 'unknown', 'unknown', 0.99),
      run('t', 1, 'unknown', 'unknown', 0.97),
    ]);
    expect(graded.settle).toBeNull();
    expect(graded).toMatchObject({ judged: true, answers: 2, unknowns: 2 });
  });

  it('leaves a ticket never judged out of play, with the reason', () => {
    expect(verdict([run('t', 0, 'owned')]).outOfPlay).toBe('owned');
    // A post-call ownership keeps its prediction, and is still not a judgement.
    expect(verdict([run('t', 0, 'owned', 'sales', 0.9)])).toMatchObject({
      judged: false,
      outOfPlay: 'owned',
      answers: 1,
    });
    expect(verdict([run('t', 0, 'after_settle')]).outOfPlay).toBe('settled_elsewhere');
    expect(verdict([run('t', 0, 'capped')]).outOfPlay).toBe('capped');
    expect(verdict([run('t', 0, 'failed')]).outOfPlay).toBe('failed');
    expect(verdict([run('t', 0, 'below_threshold', 'sales', 0.3)]).outOfPlay).toBeNull();
  });
});

describe('the label', () => {
  const settled = [run('t', 0, 'would_apply', 'sales', 0.8)];

  it("is a person's latest category_changed", () => {
    const graded = verdict(settled, [person('t', 5, 'customer_support'), person('t', 6, 'sales')]);
    expect(graded.label).toEqual({ key: 'sales' });
  });

  it('is never a rule, a form or Jev, which write the same column', () => {
    const graded = verdict(settled, [
      rule('t', 5, 'sales'),
      { ...rule('t', 6, 'sales'), actorLabel: 'form:returns' },
      jevWrite('t', 7, 'sales', 'archive-1'),
    ]);
    expect(graded.label).toBeNull();
    expect(graded.touchedByPerson).toBe(false);
  });

  it('is not ground truth once Jev has written, since agreeing leaves no event', () => {
    const graded = verdict(
      [run('t', 0, 'applied', 'sales', 0.9)],
      [jevWrite('t', 0, 'sales'), person('t', 9, 'customer_support')],
    );
    expect(graded.label).toBeNull();
    expect(graded.labelledAfterJev).toBe(true);
    expect(graded.filed).toEqual({ key: 'sales', changedTo: { key: 'customer_support' } });
  });

  it('counts a write under another label as Jev too', () => {
    // The backfill's `apply` names the record label it filed from.
    const graded = verdict(settled, [
      jevWrite('t', 2, 'sales', 'backlog-1'),
      person('t', 9, 'customer_support'),
    ]);
    expect(graded.label).toBeNull();
    // Filed under the other label, so not this label's filing.
    expect(graded.filed).toBeNull();
    expect(graded.writtenByJev).toBe(true);
  });

  it('can say no category, when a person cleared one', () => {
    const graded = verdict(settled, [person('t', 5, 'sales'), person('t', 6, null)]);
    expect(graded.label).toEqual({ key: null });
  });
});

describe('the rules baseline', () => {
  it('is the first message the detector mapped, Jev settled or not', () => {
    const graded = verdict([
      run('t', 0, 'unknown', 'unknown', 0.9),
      run('t', 1, 'would_apply', 'sales', 0.8),
      run('t', 2, 'after_settle', null, null, { baselineKey: 'courier_jobs' }),
    ]);
    // `after_settle` counts: the rules, still without an answer, keep reading.
    expect(graded.baseline).toBe('courier_jobs');
  });

  it('stops where the ticket left Jev window', () => {
    expect(
      verdict([
        run('t', 0, 'below_threshold', 'sales', 0.3),
        run('t', 1, 'owned', null, null, { baselineKey: 'sales' }),
      ]).baseline,
    ).toBeNull();
    expect(
      verdict([
        run('t', 0, 'below_threshold', 'sales', 0.3),
        run('t', 1, 'capped', null, null, { baselineKey: 'sales' }),
      ]).baseline,
    ).toBeNull();
  });
});

describe('settleAt, the threshold sweep', () => {
  const runs = [
    run('t', 0, 'below_threshold', 'customer_support', 0.45),
    run('t', 1, 'unknown', 'unknown', 0.95),
    run('t', 2, 'would_apply', 'sales', 0.7),
    run('t', 3, 'after_settle'),
  ];

  it('reproduces the settle at the threshold the rows were decided against', () => {
    expect(settleAt(runs, 0.6)).toEqual({ kind: 'settled', key: 'sales' });
  });

  it('settles earlier on a lower bar, on an answer the real one refused', () => {
    expect(settleAt(runs, 0.4)).toEqual({ kind: 'settled', key: 'customer_support' });
  });

  it('cannot tell on a higher bar once the next message was never asked', () => {
    expect(settleAt(runs, 0.8)).toEqual({ kind: 'unasked' });
  });

  it('settles nothing once the ticket left the window', () => {
    expect(
      settleAt([run('t', 0, 'below_threshold', 'sales', 0.5), run('t', 1, 'capped')], 0.6),
    ).toEqual({ kind: 'none' });
    expect(settleAt([run('t', 0, 'owned', 'sales', 0.99)], 0.1)).toEqual({ kind: 'none' });
  });

  it('never settles on a missing probability, nor on a failure', () => {
    expect(
      settleAt(
        [run('t', 0, 'below_threshold', 'sales', null), run('t', 1, 'failed', 'sales', 0.9)],
        0,
      ),
    ).toEqual({ kind: 'none' });
  });
});

describe('grade', () => {
  // Five tickets on WhatsApp and one on email, each in a different cell.
  const runs = [
    // Settled sales on its first message, labelled sales: right.
    run('a', 0, 'would_apply', 'sales', 0.9, { baselineKey: 'sales' }),
    // Settled sales, labelled customer support: wrong; the rules got it.
    run('b', 0, 'unknown', 'unknown', 0.8),
    run('b', 1, 'would_apply', 'sales', 0.65, { baselineKey: 'customer_support' }),
    // Never settled, labelled merchant support: a miss.
    run('c', 0, 'below_threshold', 'merchant_support', 0.5, { baselineKey: 'merchant_support' }),
    run('c', 1, 'capped'),
    // Settled courier jobs, never labelled.
    run('d', 0, 'would_apply', 'courier_jobs', 0.95),
    // Owned from the start: out of play.
    run('e', 0, 'owned'),
    // Email, settled customer support, labelled so.
    run('f', 0, 'would_apply', 'customer_support', 0.75, { channel: 'email' }),
  ];
  const events = [
    person('a', 30, 'sales'),
    person('b', 30, 'customer_support'),
    person('c', 30, 'merchant_support'),
    person('e', 0, 'sales'),
    person('f', 30, 'customer_support'),
  ];
  const report = grade(input(runs, events, { thresholds: [0.5, 0.8] }));

  it('slices every figure by channel, the busiest first, and in total', () => {
    expect(report.slices.map((slice) => slice.channel)).toEqual(['whatsapp', 'email']);
    expect(report.total).toEqual({
      channel: null,
      tickets: 6,
      judged: 5,
      settled: 4,
      settledOnFirst: 3,
      answers: 6,
      unknowns: 1,
      labelled: 4,
      settledLabelled: 3,
      right: 2,
      rulesAnswered: 3,
      rulesRight: 3,
      comparable: 2,
      agree: 1,
    });
    expect(report.outOfPlay).toEqual({ owned: 1, settled_elsewhere: 0, capped: 0, failed: 0 });
  });

  it('grades precision on what Jev settled and recall on what people labelled', () => {
    const byKey = Object.fromEntries(report.categories.map((each) => [each.key, each]));
    expect(byKey.sales).toEqual({
      key: 'sales',
      settled: 2,
      graded: 2,
      right: 1,
      labelled: 1,
      rulesGraded: 1,
      rulesRight: 1,
    });
    expect(byKey.merchant_support).toMatchObject({ settled: 0, labelled: 1, right: 0 });
    expect(byKey.customer_support).toMatchObject({
      graded: 1,
      right: 1,
      labelled: 2,
      // f's text mapped to nothing, so the rules graded b alone.
      rulesGraded: 1,
      rulesRight: 1,
    });
    // Settled and unlabelled: in the settled count, out of the grade.
    expect(byKey.courier_jobs).toMatchObject({ settled: 1, graded: 0, labelled: 0 });
    expect(report.categories.map((each) => each.key)).toEqual(KEYS);
  });

  it('draws the confusion matrix with the misses Jev never settled', () => {
    expect(report.confusion).toEqual(
      expect.arrayContaining([
        { label: 'sales', settled: 'sales', count: 1 },
        { label: 'customer_support', settled: 'sales', count: 1 },
        { label: 'merchant_support', settled: null, count: 1 },
        { label: 'customer_support', settled: 'customer_support', count: 1 },
      ]),
    );
    expect(report.confusion).toHaveLength(4);
  });

  it('sweeps the thresholds asked for and the one in force', () => {
    expect(report.sweep.map((row) => [row.threshold, row.inForce])).toEqual([
      [0.5, false],
      [0.6, true],
      [0.8, false],
    ]);
    const [low, real, high] = report.sweep;
    // At 0.5, c settles on merchant support and is right.
    expect(low).toMatchObject({ settled: 5, unasked: 0, graded: 4, right: 3 });
    expect(real).toMatchObject({ settled: 4, unasked: 0, graded: 3, right: 2 });
    // At 0.8, b and f fall below the bar with no message after their settle,
    // so they are unsettled rather than unasked.
    expect(high).toMatchObject({ settled: 2, graded: 1, right: 1 });
    expect(low!.byCategory.find((each) => each.key === 'merchant_support')).toEqual({
      key: 'merchant_support',
      graded: 1,
      right: 1,
    });
  });

  it('counts unlabelled tickets by Jev answer, and the ones it never settled', () => {
    expect(report.sample).toEqual([
      { key: 'sales', labelled: 2, waiting: 0 },
      { key: 'customer_support', labelled: 1, waiting: 0 },
      { key: 'courier_jobs', labelled: 0, waiting: 1 },
      { key: null, labelled: 1, waiting: 0 },
    ]);
    expect(report.toLabel).toEqual([{ conversationId: 'd', number: 103, channel: 'whatsapp' }]);
  });
});

describe('the sample', () => {
  it('leaves out what a person touched, what Jev wrote to and what cannot be labelled', () => {
    const runs = ['p', 'q', 'r', 's'].map((id) => run(id, 0, 'would_apply', 'sales', 0.9));
    const events = [
      // A label after a Jev write is not graded, but the ticket has been looked at.
      jevWrite('p', 0, 'sales'),
      person('p', 5, 'customer_support'),
      jevWrite('q', 0, 'sales'),
    ];
    const tickets = new Map<string, GradingTicket>([
      ['p', { number: 1, labellable: true }],
      ['q', { number: 2, labellable: true }],
      ['r', { number: 3, labellable: false }],
      ['s', { number: 4, labellable: true }],
    ]);
    const report = grade(input(runs, events, { tickets }));
    expect(report.sample).toEqual([{ key: 'sales', labelled: 0, waiting: 1 }]);
    expect(report.toLabel).toEqual([{ conversationId: 's', number: 4, channel: 'whatsapp' }]);
  });

  it('offers at most a page of each stratum, mixed into one list that names no answer', () => {
    const name = (n: number) => `id-${String(n).padStart(2, '0')}`;
    const unsettled = Array.from({ length: SAMPLE_SIZE + 5 }, (_, n) => name(2 * n));
    const sales = Array.from({ length: 3 }, (_, n) => name(2 * n + 1));
    const runs = [
      ...[...unsettled].reverse().map((id) => run(id, 0, 'below_threshold', 'sales', 0.3)),
      ...sales.map((id) => run(id, 0, 'would_apply', 'sales', 0.9)),
    ];
    const report = grade(input(runs));
    expect(report.sample).toEqual([
      { key: 'sales', labelled: 0, waiting: 3 },
      { key: null, labelled: 0, waiting: SAMPLE_SIZE + 5 },
    ]);
    // The first page of each, interleaved by id: nothing in the list or its
    // order says which stratum a ticket came from.
    expect(report.toLabel.map((ticket) => ticket.conversationId)).toEqual(
      [...sales, ...unsettled.slice(0, SAMPLE_SIZE)].sort(),
    );
    expect(Object.keys(report.toLabel[0]!).sort()).toEqual(['channel', 'conversationId', 'number']);
  });
});

describe('what Jev filed', () => {
  it('counts a change only when the person last word differs', () => {
    const runs = ['a', 'b', 'c'].map((id) => run(id, 0, 'applied', 'sales', 0.9));
    const events = [
      jevWrite('a', 0, 'sales'),
      jevWrite('b', 0, 'sales'),
      person('b', 5, 'courier_jobs'),
      jevWrite('c', 0, 'sales'),
      person('c', 5, 'courier_jobs'),
      // Changed back: the person agrees with Jev in the end.
      person('c', 6, 'sales'),
    ];
    expect(grade(input(runs, events)).filed).toEqual([
      {
        key: 'sales',
        filed: 3,
        changed: 1,
        changedTo: [{ key: 'courier_jobs', count: 1 }],
      },
    ]);
  });
});

describe('the keys', () => {
  it('follow the registry, then any other key seen, alphabetically', () => {
    const runs = [
      run('a', 0, 'would_apply', 'zeta_retired', 0.9),
      run('b', 0, 'below_threshold', 'alpha_retired', 0.2),
    ];
    expect(grade(input(runs)).categories.map((each) => each.key)).toEqual([
      ...KEYS,
      'alpha_retired',
      'zeta_retired',
    ]);
  });
});
