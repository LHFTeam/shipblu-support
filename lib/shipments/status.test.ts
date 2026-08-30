import { describe, expect, it } from 'vitest';
import {
  commentText,
  humaniseStatus,
  PHRASE_GROUPS,
  stageDisplay,
  stageFor,
  statusLabel,
  TRACKING_STEPS,
} from './status';

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

  it('keeps an attempted delivery on the line, so an estimate is still fetched', () => {
    // `terminal` decides whether the current-estimate endpoint is called at all
    // (lib/shipments/sync.ts). A parcel whose delivery was attempted is still
    // coming, and is exactly the parcel whose estimate has moved — the one this
    // was built against was booked for 2026-08-22 and now reads 2026-09-01.
    expect(stageDisplay('delivery_attempted').terminal).toBe(false);
    expect(stageDisplay('return_to_origin').terminal).toBe(true);
    expect(stageDisplay('delivered').terminal).toBe(true);
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

  it('words a failed attempt the way ShipBlu words it', () => {
    // Specified rather than chosen: this is the phrase ShipBlu uses for it, and
    // the page agreeing with the SMS about the same parcel is the whole point.
    expect(statusLabel('ar', 'delivery_attempted')).toBe('محاولة تسليم غير ناجحة');
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

describe('phrase keys', () => {
  /**
   * The keys are the primary key of `shipment_phrases`, so a duplicate would
   * silently give two phrases one override — an admin renaming "delivered"
   * would find a courier reason had changed too. Cheap to pin, impossible to
   * notice by reading.
   */
  it('are unique across every table', () => {
    const keys = PHRASE_GROUPS.flatMap((group) => group.rows.map((row) => row.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('are safe to store and to put in a URL', () => {
    for (const key of PHRASE_GROUPS.flatMap((group) => group.rows.map((row) => row.key))) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('statusLabel overrides', () => {
  it('prefers the wording an admin saved', () => {
    expect(statusLabel('ar', 'delivered', { delivered: 'اتسلمت' })).toBe('اتسلمت');
  });

  it('falls back to the default when the override is blank', () => {
    // Clearing the box in the admin screen is how a phrase is reset, so a blank
    // override must never reach the page as an empty badge.
    expect(statusLabel('ar', 'delivered', { delivered: '   ' })).toBe(
      statusLabel('ar', 'delivered'),
    );
  });

  it('does not let one phrase override another', () => {
    const overrides = { delivered: 'اتسلمت' };
    expect(statusLabel('ar', 'out_for_delivery', overrides)).toBe(
      statusLabel('ar', 'out_for_delivery'),
    );
  });

  it('leaves the English page alone whatever is saved', () => {
    expect(statusLabel('en', 'delivered', { delivered: 'اتسلمت' })).toBe('Delivered');
  });
});

describe('commentText', () => {
  /**
   * Both of these are real: production stores an English reason code, a dash,
   * and whatever the courier typed in Arabic. Under an Arabic status that left
   * the most useful line on the page half in a language the reader may not have.
   */
  it('translates the reason code and keeps the courier own words', () => {
    expect(commentText('ar', 'Customer refused to accept the shipment - الاوردر ناقص')).toBe(
      'العميل رفض استلام الشحنة - الاوردر ناقص',
    );
    expect(commentText('ar', 'Customer Rescheduled - مسافر')).toBe(
      'العميل طلب تأجيل التسليم - مسافر',
    );
  });

  it('never splits the note itself on a dash inside it', () => {
    expect(
      commentText('ar', 'Customer refused to accept the shipment - الاوردر ناقص - مش هيستلم'),
    ).toBe('العميل رفض استلام الشحنة - الاوردر ناقص - مش هيستلم');
  });

  it('shows an unrecognised comment exactly as it arrived', () => {
    // The same refusal statusLabel makes: half-English beats confidently wrong
    // about why a parcel did not arrive.
    expect(commentText('ar', 'test')).toBe('test');
    expect(commentText('ar', 'Held at customs - رسوم')).toBe('Held at customs - رسوم');
  });

  it('leaves a comment the courier already wrote in Arabic alone', () => {
    expect(commentText('ar', 'الاوردر ناقص - مش هيستلم')).toBe('الاوردر ناقص - مش هيستلم');
  });

  it('does not touch the English page', () => {
    expect(commentText('en', 'Customer Rescheduled - مسافر')).toBe('Customer Rescheduled - مسافر');
  });

  it('takes an admin override for the reason too', () => {
    expect(
      commentText('ar', 'Customer Rescheduled - مسافر', { reason_rescheduled: 'العميل أجّل' }),
    ).toBe('العميل أجّل - مسافر');
  });

  it('says nothing when there is no comment', () => {
    expect(commentText('ar', null)).toBe('');
    expect(commentText('ar', '   ')).toBe('');
  });
});
