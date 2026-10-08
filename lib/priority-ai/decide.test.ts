import { describe, expect, it } from 'vitest';
import { decide, type DecisionInput } from './decide';

/**
 * The rules that keep an automated writer of `conversations.priority` from
 * fighting the people who also write it, or from flapping between levels as a
 * ticket's messages arrive. Each case is a way the column could be wrong while
 * looking exactly like a column somebody set.
 */

const BASE: DecisionInput = {
  mode: 'apply',
  predicted: 'urgent',
  probability: 0.9,
  minProbability: 0.6,
  current: 'medium',
  lastApplied: null,
  ownedElsewhere: false,
  firstConfident: true,
};

function run(overrides: Partial<DecisionInput>) {
  return decide({ ...BASE, ...overrides });
}

describe('decide: who owns the priority', () => {
  it('raises an untouched ticket on a confident answer', () => {
    expect(run({})).toEqual({ outcome: 'applied', to: 'urgent' });
  });

  it('never touches a priority a person, a rule or a form chose', () => {
    expect(run({ ownedElsewhere: true })).toEqual({ outcome: 'set_by_person', to: null });
  });

  it('reads a priority it did not leave there as somebody else’s', () => {
    // No event says who moved it — a form default, an agent opening the ticket
    // with a level chosen — but the column no longer holds `medium`.
    expect(run({ current: 'high' })).toEqual({ outcome: 'set_by_person', to: null });
  });

  it('reads a priority moved since its own last write as somebody else’s', () => {
    expect(run({ lastApplied: 'high', current: 'low', firstConfident: false })).toEqual({
      outcome: 'set_by_person',
      to: null,
    });
  });

  it('checks ownership before confidence, so an overruled answer is not counted as unsure', () => {
    expect(run({ ownedElsewhere: true, probability: 0.1 }).outcome).toBe('set_by_person');
  });
});

describe('decide: the threshold', () => {
  it('applies at exactly the threshold', () => {
    expect(run({ probability: 0.6 }).outcome).toBe('applied');
  });

  it('does nothing just below it', () => {
    expect(run({ probability: 0.59 })).toEqual({ outcome: 'below_threshold', to: null });
  });

  it('reads a missing probability as unsure, not as certain', () => {
    expect(run({ probability: null }).outcome).toBe('below_threshold');
  });
});

describe('decide: up only after the first confident answer', () => {
  it('lets the first confident answer lower an untouched ticket', () => {
    expect(run({ predicted: 'low' })).toEqual({ outcome: 'applied', to: 'low' });
  });

  it('does not lower a ticket once an earlier answer was confident', () => {
    // "thanks" after the message that made it urgent.
    expect(
      run({ predicted: 'low', current: 'urgent', lastApplied: 'urgent', firstConfident: false }),
    ).toEqual({ outcome: 'not_raised', to: null });
  });

  it('does not lower one an earlier answer left at the default either', () => {
    // The first message was confidently medium; the second is "ok".
    expect(run({ predicted: 'low', firstConfident: false }).outcome).toBe('not_raised');
  });

  it('still raises a ticket it set earlier', () => {
    expect(
      run({ predicted: 'urgent', current: 'high', lastApplied: 'high', firstConfident: false }),
    ).toEqual({ outcome: 'applied', to: 'urgent' });
  });

  it('records agreement as unchanged rather than as a write', () => {
    expect(run({ predicted: 'medium' })).toEqual({ outcome: 'unchanged', to: null });
  });
});

describe('decide: shadow mode', () => {
  it('records what it would have done and writes nothing', () => {
    expect(run({ mode: 'shadow' })).toEqual({ outcome: 'would_apply', to: null });
  });

  it('answers every other rule exactly as apply does', () => {
    expect(run({ mode: 'shadow', probability: 0.2 }).outcome).toBe('below_threshold');
    expect(run({ mode: 'shadow', ownedElsewhere: true }).outcome).toBe('set_by_person');
  });
});
