import { describe, expect, it } from 'vitest';
import { stageDisplay, stageFor, TRACKING_STEPS } from './status';

/**
 * The cases worth pinning are the ones where a wrong answer is worse than no
 * answer: a label that reads as `delivered` when it is not, a stage guessed from
 * a label nobody recognised, and the two-language spellings that reach us in
 * roughly equal volume.
 */
describe('stageFor', () => {
  it('reads the separators a platform picks between words', () => {
    for (const label of ['out for delivery', 'OUT_FOR_DELIVERY', 'Out-For-Delivery']) {
      expect(stageFor(label)).toBe('out_for_delivery');
    }
  });

  it('matches whole words, so a longer word does not claim a stage', () => {
    expect(stageFor('Renewed label printed')).toBe('unknown');
  });

  it('never lets a return read as a delivery', () => {
    expect(stageFor('Returned to sender')).toBe('returned');
    expect(stageFor('RTO completed')).toBe('returned');
  });

  it('reads a failed attempt as an attempt, not as transit', () => {
    expect(stageFor('Failed delivery attempt')).toBe('attempted');
    expect(stageFor('Delivery attempted — recipient unreachable')).toBe('attempted');
  });

  it('reads Arabic labels, including Arabic-Indic digits', () => {
    expect(stageFor('تم التسليم')).toBe('delivered');
    expect(stageFor('خرجت للتسليم')).toBe('out_for_delivery');
    expect(stageFor('محاولة ٢')).toBe('attempted');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(stageFor(null)).toBe('unknown');
    expect(stageFor('')).toBe('unknown');
    expect(stageFor('   ')).toBe('unknown');
    expect(stageFor('AWAITING_CUSTOMS_CLEARANCE')).toBe('unknown');
  });
});

describe('stageDisplay', () => {
  it('gives an unknown label no step and no tone of its own', () => {
    const display = stageDisplay('AWAITING_CUSTOMS_CLEARANCE');
    expect(display).toEqual({ stage: 'unknown', tone: 'neutral', step: null, terminal: false });
  });

  it('keeps a failed attempt at the step it failed on', () => {
    expect(stageDisplay('Failed delivery attempt').step).toBe(
      stageDisplay('Out for delivery').step,
    );
  });

  it('takes a returned parcel off the line to delivered', () => {
    expect(stageDisplay('Returned to sender').step).toBeNull();
    expect(stageDisplay('Delivered').step).toBe(TRACKING_STEPS.length - 1);
  });
});
