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

  /**
   * The eight statuses `api.shipblu.com` actually emits, read off a real
   * delivery order rather than guessed.
   *
   * Pinned as a set because the failure they had is invisible one at a time:
   * three of them reached `unknown`, which draws a bare label with no stepper
   * and no tone — and they cover the whole first half of a parcel's life, so a
   * customer checking early saw nothing useful and nobody watching a delivered
   * parcel would ever have noticed.
   */
  it('recognises every status the platform actually sends', () => {
    expect(stageFor('created')).toBe('created');
    expect(stageFor('pickup_requested')).toBe('created');
    expect(stageFor('out_for_pickup')).toBe('created');
    expect(stageFor('picked_up')).toBe('in_transit');
    expect(stageFor('in_transit')).toBe('in_transit');
    expect(stageFor('en_route')).toBe('in_transit');
    expect(stageFor('out_for_delivery')).toBe('out_for_delivery');
    expect(stageFor('delivered')).toBe('delivered');
  });

  it('never reads a pickup step as the parcel being under way', () => {
    // The courier is going to collect it. Telling a recipient it is on its way
    // while it is still on a shelf in the shop is the error worth pinning.
    for (const label of ['pickup_requested', 'out_for_pickup']) {
      expect(stageDisplay(label).step).toBe(0);
      expect(stageDisplay(label).terminal).toBe(false);
    }
  });

  it('falls back to unknown rather than guessing', () => {
    expect(stageFor(null)).toBe('unknown');
    expect(stageFor('')).toBe('unknown');
    expect(stageFor('   ')).toBe('unknown');
    expect(stageFor('AWAITING_CUSTOMS_CLEARANCE')).toBe('unknown');
  });
});

describe('stageDisplay', () => {
  it('gives an unknown label no step and the neutral badge', () => {
    const display = stageDisplay('AWAITING_CUSTOMS_CLEARANCE');
    expect(display).toEqual({ stage: 'unknown', tone: 'unknown', step: null, terminal: false });
  });

  it('does not let out for delivery share a badge with in transit', () => {
    // The whole reason the badge reads from the design system's taxonomy rather
    // than from four generic tones.
    expect(stageDisplay('Out for delivery').tone).not.toBe(stageDisplay('In transit').tone);
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
