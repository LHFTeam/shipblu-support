import { describe, expect, it } from 'vitest';
import type { CategoryOutcome } from './decide';
import {
  SAMPLE_SIZE,
  grade,
  settleAt,
  ticketVerdicts,
  type AskedElsewhere,
  type GradingEvent,
  type GradingInput,
  type GradingRun,
  type GradingTicket,
} from './grade';

/**
 * The grading rules, one case each: what settles a ticket, what counts as a
 * person's label, how the rules baseline is read, how a stratified sample is
 * weighed, what a threshold would have done, and which tickets are offered for
 * labelling. Each is a way the report could say Jev is better or worse than it
 * is, and nothing on the page would show it.
 */

const LABEL = 'live';
const KEYS = ['sales', 'customer_support', 'merchant_support', 'courier_jobs'];
const START = Date.parse('2026-10-01T09:00:00Z');
const minute = (n: number) => new Date(START + n * 60_000);
const messageAt = (conversationId: string, at: number) =>
  `${conversationId}:${String(at).padStart(3, '0')}`;

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
    messageId: messageAt(conversationId, at),
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
    messageId: null,
  };
}

/** Jev's write, answering the ticket's first message unless told another. */
function jevWrite(
  conversationId: string,
  at: number,
  key: string,
  runLabel = LABEL,
  messageId = messageAt(conversationId, 0),
): GradingEvent {
  return {
    conversationId,
    createdAt: minute(at),
    agentId: null,
    actorLabel: 'jev:category',
    key,
    runLabel,
    messageId,
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
    messageId: null,
  };
}

/** An answer to the ticket's message `at` held in another view of the label. */
function askedThere(conversationId: string, at: number): AskedElsewhere {
  return { conversationId, messageId: messageAt(conversationId, at), messageCreatedAt: minute(at) };
}

function input(
  runs: GradingRun[],
  events: GradingEvent[] = [],
  extra: Partial<GradingInput> = {},
): GradingInput {
  const tickets = new Map<string, GradingTicket>();
  for (const [index, id] of [...new Set(runs.map((each) => each.conversationId))].entries()) {
    tickets.set(id, { number: 100 + index, labellable: true, windowOpen: false });
  }
  return {
    runLabel: LABEL,
    runs,
    askedElsewhere: [],
    events,
    tickets,
    categoryKeys: KEYS,
    thresholds: [],
    ...extra,
  };
}

function verdict(
  runs: GradingRun[],
  events: GradingEvent[] = [],
  askedElsewhere: AskedElsewhere[] = [],
) {
  const [only] = ticketVerdicts(LABEL, runs, events, askedElsewhere);
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

  // WhatsApp stamps a burst to the second; the live job and the backfill
  // break the tie by message id, and so must the grade, whatever order the
  // rows were read in.
  // A job that ran late and found the ticket answered sits before the message
  // Jev settled on; that message is still the first this run judged.
  it('counts a settle as on the first message past a row Jev never judged', () => {
    expect(
      verdict([run('t', 0, 'capped'), run('t', 1, 'would_apply', 'sales', 0.9)]).settle,
    ).toEqual({ key: 'sales', onFirstMessage: true });
    expect(
      verdict([run('t', 0, 'unknown', 'unknown', 0.9), run('t', 1, 'would_apply', 'sales', 0.9)])
        .settle,
    ).toEqual({ key: 'sales', onFirstMessage: false });
  });

  it('orders messages of the same instant by their id, as the live job does', () => {
    const graded = verdict([
      run('t', 0, 'after_settle', null, null, { messageId: 'm-b' }),
      run('t', 0, 'would_apply', 'sales', 0.9, { messageId: 'm-a' }),
    ]);
    expect(graded.settle).toEqual({ key: 'sales', onFirstMessage: true });
    expect(settleAt(graded.runs, 0.6)).toEqual({ kind: 'settled', key: 'sales' });
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
    expect(graded.labelledAfterWrite).toBe(true);
    expect(graded.filed).toEqual({ key: 'sales', changedTo: { key: 'customer_support' } });
  });

  // The same asymmetry as Jev's: a supervisor who agrees with the rule changes
  // nothing, so only the disagreements would be graded.
  it('is not ground truth once a rule has written either', () => {
    const graded = verdict(settled, [rule('t', 5, 'sales'), person('t', 9, 'customer_support')]);
    expect(graded.label).toBeNull();
    expect(graded.labelledAfterWrite).toBe(true);
  });

  it('counts a write under another label as Jev too, but not as this run’s filing', () => {
    // The backfill's `apply` names the record label it filed from.
    const graded = verdict(settled, [
      jevWrite('t', 2, 'sales', 'backlog-1'),
      person('t', 9, 'customer_support'),
    ]);
    expect(graded.label).toBeNull();
    expect(graded.filed).toBeNull();
    expect(graded.writtenByJev).toBe(true);
  });

  // A live write in answer to a message asked under another question is that
  // question's filing.
  it('files a write only against the rows it answered', () => {
    const graded = verdict(settled, [jevWrite('t', 2, 'sales', LABEL, 'another-message')]);
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

  // After a settle every later message is `after_settle`, never `capped`; the
  // rules still get only the five messages Jev could have been asked about.
  it('reads no further than the five messages Jev had', () => {
    const runs = (at: number) => [
      run('t', 0, 'would_apply', 'customer_support', 0.9),
      ...Array.from({ length: 5 }, (_, n) =>
        run('t', n + 1, 'after_settle', null, null, n + 1 === at ? { baselineKey: 'sales' } : {}),
      ),
    ];
    expect(verdict(runs(4)).baseline).toBe('sales');
    expect(verdict(runs(5)).baseline).toBeNull();
  });

  // Message 0's job failed transiently, retried after the first reply and was
  // capped; message 1's had already settled. Message 0 arrived inside Jev's
  // window, and the rules read it.
  it('reads past an owned or capped row that a later asked message shows was out of order', () => {
    expect(
      verdict([
        run('t', 0, 'capped', null, null, { baselineKey: 'sales' }),
        run('t', 1, 'would_apply', 'sales', 0.9),
      ]).baseline,
    ).toBe('sales');
  });

  // The burst `settleAt` settles on: the rules reach the message Jev settled on.
  it('never stops short of the message Jev settled on', () => {
    expect(
      verdict([
        ...Array.from({ length: 4 }, (_, n) => run('t', n, 'unknown', 'unknown', 0.9)),
        run('t', 4, 'capped', 'unknown', 0.9),
        run('t', 5, 'would_apply', 'sales', 0.9, { baselineKey: 'sales' }),
      ]).baseline,
    ).toBe('sales');
  });

  // The live cap counts no failure, so Jev was asked about a sixth message.
  it('gives a failure no place of the five', () => {
    const runs = [
      run('t', 0, 'failed', null, null),
      run('t', 1, 'would_apply', 'customer_support', 0.9),
      ...Array.from({ length: 5 }, (_, n) =>
        run('t', n + 2, 'after_settle', null, null, n + 2 === 5 ? { baselineKey: 'sales' } : {}),
      ),
    ];
    expect(verdict(runs).baseline).toBe('sales');
  });

  it('counts the asks the label holds in its other views', () => {
    const runs = [
      run('t', 4, 'would_apply', 'customer_support', 0.9),
      run('t', 5, 'after_settle', null, null, { baselineKey: 'sales' }),
    ];
    const shadow = [0, 1, 2, 3].map((at) => askedThere('t', at));
    expect(verdict(runs, [], shadow).baseline).toBeNull();
    expect(verdict(runs, [], shadow.slice(1)).baseline).toBe('sales');
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

  // Its job asked before the settle landed: an answer, not an unasked message.
  it('reads the answer an after_settle row holds', () => {
    expect(
      settleAt(
        [
          run('t', 0, 'would_apply', 'customer_support', 0.65),
          run('t', 1, 'after_settle', 'sales', 0.9),
        ],
        0.7,
      ),
    ).toEqual({ kind: 'settled', key: 'sales' });
  });

  // Settled on its fifth asked message: the sixth would have been capped.
  it('counts the cap, so five answers below the bar are unsettled, not unknown', () => {
    expect(
      settleAt(
        [
          ...Array.from({ length: 4 }, (_, n) => run('t', n, 'below_threshold', 'sales', 0.5)),
          run('t', 4, 'would_apply', 'sales', 0.7),
          run('t', 5, 'after_settle'),
        ],
        0.8,
      ),
    ).toEqual({ kind: 'none' });
  });

  // Jobs run in no order: one that found the ticket owned can sit before a
  // message whose job had already asked.
  it('passes over an owned row before a message that was still asked', () => {
    expect(settleAt([run('t', 0, 'owned'), run('t', 1, 'would_apply', 'sales', 0.9)], 0.6)).toEqual(
      { kind: 'settled', key: 'sales' },
    );
  });

  // Six messages in a burst, five workers: message 5 starts once message 0
  // commits, is asked while four answers are in, and commits before the slow
  // message 4, which then finds five and is capped with its answer. In arrival
  // order message 5 is the sixth asked; the live job asked it inside its cap.
  it('never caps a message Jev judged, which the live job asked inside its cap', () => {
    const burst = [
      ...Array.from({ length: 4 }, (_, n) => run('t', n, 'unknown', 'unknown', 0.9)),
      run('t', 4, 'capped', 'unknown', 0.9),
      run('t', 5, 'would_apply', 'sales', 0.9),
    ];
    expect(verdict(burst).settle).toEqual({ key: 'sales', onFirstMessage: false });
    expect(settleAt(burst, 0.6)).toEqual({ kind: 'settled', key: 'sales' });
    expect(settleAt(burst, 0.5)).toEqual({ kind: 'settled', key: 'sales' });
  });

  // Four messages asked in shadow, then the switch to apply: the apply view
  // holds the fifth and the sixth, and the live job capped the sixth.
  it('counts the asks the label holds in its other views towards the cap', () => {
    const apply = [run('t', 4, 'applied', 'sales', 0.65), run('t', 5, 'after_settle')];
    const shadow = [0, 1, 2, 3].map((at) => askedThere('t', at));
    expect(settleAt(apply, 0.7, shadow)).toEqual({ kind: 'none' });
    expect(settleAt(apply, 0.7)).toEqual({ kind: 'unasked' });
    // Only the asks that came first: a later one is not counted before a row.
    expect(settleAt(apply, 0.7, [...shadow.slice(1), askedThere('t', 9)])).toEqual({
      kind: 'unasked',
    });
  });

  it('sweeps with the asks the other views hold', () => {
    const apply = [run('t', 4, 'applied', 'sales', 0.65), run('t', 5, 'after_settle')];
    const askedElsewhere = [0, 1, 2, 3].map((at) => askedThere('t', at));
    const high = grade(input(apply, [], { thresholds: [0.7], askedElsewhere })).sweep.find(
      (row) => row.threshold === 0.7,
    );
    expect(high).toMatchObject({ settled: 0, unasked: 0 });
  });
});

describe('grade', () => {
  // Five tickets on WhatsApp and one on email, each in a different cell. Every
  // stratum's labels are all its tickets, so every weight is 1.
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
      jev: { right: 2, of: 3, rate: 2 / 3 },
      rules: { right: 3, of: 3, rate: 1 },
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
      precision: { right: 1, of: 2, rate: 0.5 },
      recall: { right: 1, of: 1, rate: 1 },
      rulesPrecision: { right: 1, of: 1, rate: 1 },
      rulesRecall: { right: 1, of: 1, rate: 1 },
    });
    expect(byKey.merchant_support).toMatchObject({
      settled: 0,
      recall: { right: 0, of: 1, rate: 0 },
    });
    expect(byKey.customer_support).toMatchObject({
      precision: { right: 1, of: 1 },
      recall: { right: 1, of: 2 },
      // f's text mapped to nothing, so the rules graded b alone.
      rulesPrecision: { right: 1, of: 1 },
      rulesRecall: { right: 1, of: 2 },
    });
    // Settled and unlabelled: in the settled count, out of the grade.
    expect(byKey.courier_jobs).toMatchObject({
      settled: 1,
      precision: { right: 0, of: 0, rate: null },
    });
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
    expect(report.thresholdsInForce).toEqual([0.6]);
    expect(report.sweep.map((row) => [row.threshold, row.inForce])).toEqual([
      [0.5, false],
      [0.6, true],
      [0.8, false],
    ]);
    const [low, real, high] = report.sweep;
    // At 0.5, c settles on merchant support and is right.
    expect(low).toMatchObject({ settled: 5, unasked: 0, jev: { right: 3, of: 4 } });
    expect(real).toMatchObject({ settled: 4, unasked: 0, jev: { right: 2, of: 3 } });
    // At 0.8, b and f fall below the bar with no message after their settle,
    // so they are unsettled rather than unasked.
    expect(high).toMatchObject({ settled: 2, jev: { right: 1, of: 1 } });
    expect(low!.byCategory.find((each) => each.key === 'merchant_support')).toEqual({
      key: 'merchant_support',
      precision: { right: 1, of: 1, rate: 1 },
    });
  });

  it('counts labelled tickets by Jev answer, and offers the unlabelled in one list', () => {
    expect(report.sample).toEqual([
      { key: 'sales', labelled: 2 },
      { key: 'customer_support', labelled: 1 },
      { key: 'courier_jobs', labelled: 0 },
      { key: null, labelled: 1 },
    ]);
    expect(report.toLabel).toEqual([{ conversationId: 'd', number: 103, channel: 'whatsapp' }]);
  });
});

describe('the weights', () => {
  // Jev settled ten tickets as sales and two as customer support; two of each
  // are labelled, as the sample draws them. One of the two customer-support
  // ones is really sales. Unweighted, sales recall is 2 of 3; the ten sales
  // tickets the two labels stand for make it 10 of 11.
  const runs = [
    ...Array.from({ length: 10 }, (_, n) => run(`s${n}`, 0, 'would_apply', 'sales', 0.9)),
    run('c0', 0, 'would_apply', 'customer_support', 0.9),
    run('c1', 0, 'would_apply', 'customer_support', 0.9),
  ];
  const events = [
    person('s0', 30, 'sales'),
    person('s1', 30, 'sales'),
    person('c0', 30, 'customer_support'),
    person('c1', 30, 'sales'),
  ];
  const report = grade(input(runs, events));
  const sales = report.categories.find((each) => each.key === 'sales')!;

  it('estimates the run from a stratified sample', () => {
    expect(sales.recall).toEqual({ right: 2, of: 3, rate: 10 / 11 });
    // Overall: 10 right of 10 sales, 1 of 2 customer support.
    expect(report.total.jev).toEqual({ right: 3, of: 4, rate: 11 / 12 });
  });

  it('leaves precision within one answer as it was sampled', () => {
    expect(sales.precision).toEqual({ right: 2, of: 2, rate: 1 });
    expect(report.categories.find((each) => each.key === 'customer_support')!.precision).toEqual({
      right: 1,
      of: 2,
      rate: 0.5,
    });
  });
});

describe('what a label can grade', () => {
  // In apply every settle is Jev's filing, and agreeing with one leaves no
  // label: only the tickets it never settled can carry one.
  const runs = [
    ...Array.from({ length: 20 }, (_, n) => run(`f${n}`, 0, 'applied', 'sales', 0.9)),
    ...Array.from({ length: 10 }, (_, n) => run(`u${n}`, 0, 'below_threshold', 'sales', 0.4)),
  ];
  const events = [
    ...Array.from({ length: 20 }, (_, n) => jevWrite(`f${n}`, 0, 'sales')),
    person('f0', 5, 'courier_jobs'),
    person('f1', 5, 'courier_jobs'),
    ...Array.from({ length: 10 }, (_, n) => person(`u${n}`, 30, 'sales')),
  ];
  const report = grade(input(runs, events));
  const sales = report.categories.find((each) => each.key === 'sales')!;

  it('leaves a ticket something wrote first out of every rate', () => {
    expect(report.writtenFirst).toBe(20);
    expect(report.settlesUnlabellable).toBe(true);
    expect(report.total.jev).toEqual({ right: 0, of: 0, rate: null });
    expect(sales.precision).toEqual({ right: 0, of: 0, rate: null });
  });

  // Not 0 of 10: the hits are the tickets Jev filed, which no label reaches.
  it('has no recall for a category whose every settle was written to', () => {
    expect(sales.recall).toBeNull();
    // A category Jev never settled has a recall, and it is nothing.
    expect(
      grade(input(runs, [...events, person('u0', 40, 'customer_support')])).categories.find(
        (each) => each.key === 'customer_support',
      )!.recall,
    ).toEqual({ right: 0, of: 1, rate: 0 });
  });

  it('does not list a stratum no label can reach as wanting labels', () => {
    expect(report.sample).toEqual([{ key: null, labelled: 10 }]);
    expect(report.filed).toEqual([
      { key: 'sales', filed: 20, changed: 2, changedTo: [{ key: 'courier_jobs', count: 2 }] },
    ]);
  });

  // A rule filing tickets Jev settled as sales: the two labels stand for the
  // two tickets a label could reach, not for the ten.
  it('weighs a stratum by the tickets a label could reach', () => {
    const shadow = [
      ...Array.from({ length: 10 }, (_, n) => run(`s${n}`, 0, 'would_apply', 'sales', 0.9)),
      run('c0', 0, 'would_apply', 'customer_support', 0.9),
      run('c1', 0, 'would_apply', 'customer_support', 0.9),
    ];
    const labels = [
      person('s0', 30, 'sales'),
      person('s1', 30, 'sales'),
      ...Array.from({ length: 8 }, (_, n) => rule(`s${n + 2}`, 10, 'courier_jobs')),
      person('c0', 30, 'customer_support'),
      person('c1', 30, 'sales'),
    ];
    const graded = grade(input(shadow, labels));
    expect(graded.writtenFirst).toBe(8);
    expect(graded.settlesUnlabellable).toBe(false);
    expect(graded.categories.find((each) => each.key === 'sales')!.recall).toEqual({
      right: 2,
      of: 3,
      rate: 2 / 3,
    });
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
      ['p', { number: 1, labellable: true, windowOpen: false }],
      ['q', { number: 2, labellable: true, windowOpen: false }],
      ['r', { number: 3, labellable: false, windowOpen: false }],
      ['s', { number: 4, labellable: true, windowOpen: false }],
    ]);
    const report = grade(input(runs, events, { tickets }));
    expect(report.sample).toEqual([{ key: 'sales', labelled: 0 }]);
    expect(report.toLabel).toEqual([{ conversationId: 's', number: 4, channel: 'whatsapp' }]);
  });

  // Labelled while Jev may still be asked, its next message would be owned,
  // and the ticket a miss it never had the chance to avoid.
  it('offers a ticket Jev never settled only once its window has closed', () => {
    const runs = [
      run('open', 0, 'below_threshold', 'sales', 0.3),
      run('asked5', 0, 'below_threshold', 'sales', 0.3),
      ...Array.from({ length: 4 }, (_, n) => run('asked5', n + 1, 'unknown', 'unknown', 0.9)),
      run('answered', 0, 'below_threshold', 'sales', 0.3),
      run('settled', 0, 'would_apply', 'sales', 0.9),
    ];
    const tickets = new Map<string, GradingTicket>([
      ['open', { number: 1, labellable: true, windowOpen: true }],
      ['asked5', { number: 2, labellable: true, windowOpen: true }],
      ['answered', { number: 3, labellable: true, windowOpen: false }],
      // A settled ticket is graded on its settle, open or not.
      ['settled', { number: 4, labellable: true, windowOpen: true }],
    ]);
    const offered = grade(input(runs, [], { tickets })).toLabel.map((each) => each.number);
    expect(offered.sort()).toEqual([2, 3, 4]);
    // Asked four times in the other mode, once here: its window is closed.
    const elsewhere = [1, 2, 3, 4].map((at) => askedThere('open', at));
    const now = grade(input(runs, [], { tickets, askedElsewhere: elsewhere }));
    expect(now.toLabel.map((each) => each.number).sort()).toEqual([1, 2, 3, 4]);
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
      { key: 'sales', labelled: 0 },
      { key: null, labelled: 0 },
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

  it('report every threshold a run was decided against', () => {
    const runs = [
      run('a', 0, 'would_apply', 'sales', 0.9, { minProbability: 0.7 }),
      run('b', 0, 'would_apply', 'sales', 0.9),
    ];
    expect(grade(input(runs)).thresholdsInForce).toEqual([0.6, 0.7]);
  });
});
