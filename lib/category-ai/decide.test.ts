import { describe, expect, it } from 'vitest';
import {
  CATEGORY_AI_ACTOR,
  RULE_PASS_GRACE_MS,
  SAME_WRITE_GRACE_MS,
  categoryOwned,
  decide,
  eventsKnownAt,
  ownedByEvent,
  preCallOutcome,
  settlingOutcomes,
  type DecisionInput,
} from './decide';

/**
 * Every rule of decision 4, one case each — the places an automated writer of
 * a column people also write goes wrong silently.
 */

const SALES = '00000000-0000-4000-8000-000000000001';
const SUPPORT = '00000000-0000-4000-8000-000000000002';

const free = { owned: false, settled: false, capped: false };

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  ...free,
  mode: 'apply',
  predictedKey: 'sales',
  probability: 0.9,
  minProbability: 0.6,
  ...over,
});

describe('categoryOwned', () => {
  const jev = (to: string | null) => ({
    type: 'category_changed',
    actorLabel: CATEGORY_AI_ACTOR,
    data: { to },
  });

  it('is free on a ticket nobody has filed', () => {
    expect(categoryOwned([], null)).toBe(false);
  });

  it('is free while the column holds what Jev last wrote', () => {
    expect(categoryOwned([jev(SUPPORT), jev(SALES)], SALES)).toBe(false);
  });

  // A person in the console carries an agent id and no label; a rule and a
  // form's default carry their own labels.
  it.each([
    ['a person', { type: 'category_changed', actorLabel: null, data: { to: SALES } }],
    [
      'a rule',
      { type: 'category_changed', actorLabel: 'automation:Merchants', data: { to: SALES } },
    ],
    ['a form default', { type: 'category_changed', actorLabel: 'form:sales', data: { to: SALES } }],
  ])('is owned once %s has chosen, whatever Jev wrote after', (_who, event) => {
    expect(categoryOwned([event, jev(SALES)], SALES)).toBe(true);
  });

  // An agent opening the ticket on the customer's behalf chose its category
  // on the New form — leaving it at none is a choice too, and writes no event.
  it('is owned on a ticket an agent opened', () => {
    expect(categoryOwned([{ type: 'opened_by_agent', actorLabel: null, data: {} }], null)).toBe(
      true,
    );
  });

  // Somebody moved the column without an event: a test, hand-written SQL, a
  // writer added later. Theirs too.
  it('is owned when the column holds anything Jev did not leave there', () => {
    expect(categoryOwned([], SALES)).toBe(true);
    expect(categoryOwned([jev(SALES)], SUPPORT)).toBe(true);
    expect(categoryOwned([jev(SALES)], null)).toBe(true);
  });
});

// What the live job may act on before it asks: the events alone. The column
// is read in a statement apart from them, so a Jev write committing in between
// shows a column that disagrees with Jev's last event — which the full test
// reads as somebody else's, and the look under the lock reads correctly.
describe('ownedByEvent', () => {
  const jev = { type: 'category_changed', actorLabel: CATEGORY_AI_ACTOR, data: { to: SALES } };

  it('leaves the column half to the full test', () => {
    expect(ownedByEvent([jev])).toBe(false);
    expect(categoryOwned([jev], null)).toBe(true);
  });

  it('owns on an agent opening the ticket, or on anybody but Jev', () => {
    expect(ownedByEvent([{ type: 'opened_by_agent', actorLabel: null, data: {} }])).toBe(true);
    expect(ownedByEvent([{ ...jev, actorLabel: null }])).toBe(true);
    expect(ownedByEvent([{ ...jev, actorLabel: 'automation:Merchants' }])).toBe(true);
  });
});

// A backfill judging a message as of its arrival: the writes its own arrival
// set off are stamped after it, and the live job, which ran after them, read
// them. A person's later label is not one of them.
describe('eventsKnownAt', () => {
  const at = new Date('2026-10-20T10:00:00Z');
  const event = (actorLabel: string | null, afterMs: number, type = 'category_changed') => ({
    type,
    actorLabel,
    data: { to: SALES },
    createdAt: new Date(at.getTime() + afterMs),
  });

  it('knows an agent opening the ticket and a form’s default however late they are stamped', () => {
    const late = 60 * 60_000;
    expect(
      eventsKnownAt([event(null, late, 'opened_by_agent'), event('form:x', late)], at),
    ).toHaveLength(2);
  });

  it('knows a rule’s write within the time a rule pass can trail its message', () => {
    expect(eventsKnownAt([event('automation:Merchants', RULE_PASS_GRACE_MS)], at)).toHaveLength(1);
    expect(eventsKnownAt([event('automation:Merchants', RULE_PASS_GRACE_MS + 1)], at)).toEqual([]);
  });

  // An agent's pick on the New form is written in the transaction that stores
  // the message, milliseconds after the time JavaScript took for it.
  it('knows a person’s write only within the transaction’s own few seconds', () => {
    expect(eventsKnownAt([event(null, SAME_WRITE_GRACE_MS)], at)).toHaveLength(1);
    expect(eventsKnownAt([event(null, 60_000)], at)).toEqual([]);
    expect(eventsKnownAt([event(null, -60_000)], at)).toHaveLength(1);
  });

  // Jev's write for this very message lands a second or two after it, inside
  // the grace a person's creation-time pick needs.
  it('knows Jev’s own write only once it is stamped by the message', () => {
    expect(eventsKnownAt([event(CATEGORY_AI_ACTOR, 1000)], at)).toEqual([]);
    expect(eventsKnownAt([event(CATEGORY_AI_ACTOR, 0)], at)).toHaveLength(1);
  });

  it('keeps the events in the order given', () => {
    const first = event(null, -2000);
    const second = event(CATEGORY_AI_ACTOR, -1000);
    expect(eventsKnownAt([first, second], at)).toEqual([first, second]);
  });
});

describe('settlingOutcomes', () => {
  it('settles on a write in apply, and on a would-be write too in shadow', () => {
    expect(settlingOutcomes('apply')).toEqual(['applied']);
    expect(settlingOutcomes('shadow')).toEqual(['applied', 'would_apply']);
    expect(settlingOutcomes('record')).toEqual(['would_apply']);
  });
});

describe('preCallOutcome', () => {
  it('asks only when nothing is known yet', () => {
    expect(preCallOutcome(free)).toBeNull();
  });

  it('orders owned before settled before capped', () => {
    expect(preCallOutcome({ owned: true, settled: true, capped: true })).toBe('owned');
    expect(preCallOutcome({ owned: false, settled: true, capped: true })).toBe('after_settle');
    expect(preCallOutcome({ owned: false, settled: false, capped: true })).toBe('capped');
  });
});

describe('decide', () => {
  it('applies a confident answer in apply, and would in shadow and in a backfill', () => {
    expect(decide(input())).toBe('applied');
    expect(decide(input({ mode: 'shadow' }))).toBe('would_apply');
    expect(decide(input({ mode: 'record' }))).toBe('would_apply');
  });

  // The facts are checked again under the lock after the call: a person can
  // answer, or another message settle, while it is out.
  it('lets an owned, settled or capped ticket win over a confident answer', () => {
    expect(decide(input({ owned: true }))).toBe('owned');
    expect(decide(input({ settled: true }))).toBe('after_settle');
    expect(decide(input({ capped: true }))).toBe('capped');
  });

  // A greeting is the most confident answer a classifier gives.
  it('never settles on unknown, however confident', () => {
    expect(decide(input({ predictedKey: 'unknown', probability: 0.99 }))).toBe('unknown');
  });

  it('holds a share below the threshold, and a missing share, below it', () => {
    expect(decide(input({ probability: 0.59 }))).toBe('below_threshold');
    expect(decide(input({ probability: 0.6 }))).toBe('applied');
    expect(decide(input({ probability: null }))).toBe('below_threshold');
  });
});
