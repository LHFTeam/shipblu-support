import { describe, expect, it } from 'vitest';
import { humaniseStatus, stageDisplay, stageFor, statusLabel, TRACKING_STEPS } from './status';

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
   * The ten statuses `api.shipblu.com` actually emits — eight read off a real
   * delivery order, `delivery_attempted` and `return_to_origin` off every
   * `tracking_events` entry stored in production.
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
    expect(stageFor('delivery_attempted')).toBe('attempted');
    expect(stageFor('delivered')).toBe('delivered');
    expect(stageFor('return_to_origin')).toBe('returned');
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

describe('humaniseStatus', () => {
  it('makes a machine token readable without changing the word', () => {
    expect(humaniseStatus('out_for_delivery')).toBe('Out for delivery');
    expect(humaniseStatus('pickup_requested')).toBe('Pickup requested');
    expect(humaniseStatus('en_route')).toBe('En route');
  });

  it('leaves Arabic alone', () => {
    // No separators to replace, and no case for toUpperCase to change.
    expect(humaniseStatus('تم التسليم')).toBe('تم التسليم');
  });

  it('does not translate, only reformats', () => {
    // The word stays the platform's own — this is the property that keeps the
    // page agreeing with the SMS ShipBlu sent about the same parcel.
    expect(humaniseStatus('Delivered')).toBe('Delivered');
    expect(humaniseStatus('')).toBe('');
  });
});

/** The ten statuses production has actually seen. See `stageFor` above. */
const PLATFORM_STATUSES = [
  'created',
  'pickup_requested',
  'out_for_pickup',
  'picked_up',
  'in_transit',
  'en_route',
  'out_for_delivery',
  'delivery_attempted',
  'delivered',
  'return_to_origin',
] as const;

describe('statusLabel', () => {
  /**
   * The bug this exists to stop coming back: `/ar/track` is the front door of
   * the help centre, its readers are Egyptian recipients holding a parcel
   * number, and the one line they opened the page for was in English.
   */
  it('words every status the platform actually sends in Arabic', () => {
    for (const token of PLATFORM_STATUSES) {
      expect(statusLabel('ar', token)).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it('gives each of them a wording of its own', () => {
    // Eight statuses collapsing into three phrases would tell a customer
    // waiting for a pickup and one waiting for a courier the same thing.
    expect(new Set(PLATFORM_STATUSES.map((token) => statusLabel('ar', token))).size).toBe(
      PLATFORM_STATUSES.length,
    );
  });

  it('leaves English alone, so the page still agrees with the platform word for word', () => {
    expect(statusLabel('en', 'out_for_delivery')).toBe('Out for delivery');
    expect(statusLabel('en', 'delivered')).toBe('Delivered');
  });

  it('never translates a label it did not recognise', () => {
    // No row matched means nothing established what the label says. Inventing an
    // Arabic phrase for it would put a fact on the page the payload never sent.
    expect(statusLabel('ar', 'AWAITING_CUSTOMS_CLEARANCE')).toBe('AWAITING CUSTOMS CLEARANCE');
  });

  it('does not rewrite a label the platform already sent in Arabic', () => {
    expect(statusLabel('ar', 'تم التسليم')).toBe('تم التسليم');
    expect(statusLabel('ar', 'خرجت للتسليم')).toBe('خرجت للتسليم');
  });

  it('never lets the Arabic wording contradict the stepper', () => {
    // The two are read off the same row, so a badge saying the parcel is out for
    // delivery while the stepper lights "in transit" cannot be written.
    expect(statusLabel('ar', 'returned to sender')).toBe(statusLabel('ar', 'RTO completed'));
    expect(stageFor('returned to sender')).toBe('returned');
  });

  it('keeps outcomes a customer would act on differently apart', () => {
    // All four are the `exception` stage and all four end the parcel's journey
    // in a different place. One reassuring phrase for the set would be the kind
    // of invented fact the rest of this module refuses to draw.
    const wordings = ['Cancelled', 'Lost in transit', 'Damaged', 'On hold'].map((label) =>
      statusLabel('ar', label),
    );
    expect(new Set(wordings).size).toBe(wordings.length);
  });

  it('says nothing at all when there is no status', () => {
    expect(statusLabel('ar', null)).toBe('');
    expect(statusLabel('ar', '')).toBe('');
    expect(statusLabel('en', undefined)).toBe('');
  });
});
