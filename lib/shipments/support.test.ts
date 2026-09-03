import { describe, expect, it } from 'vitest';
import { defaultPatterns, detectShipmentRefs } from './detect';
import { shipmentChatPrefill } from './support';

/**
 * The one thing worth testing here is not the wording, it is that the draft
 * still works as a ticket: the number has to survive into `detectShipmentRefs`,
 * or the link between the conversation and the shipment quietly stops being
 * made and nobody notices until an agent asks for a number the customer already
 * gave.
 */
describe('shipmentChatPrefill', () => {
  it('leaves a number the detector can still find, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const draft = shipmentChatPrefill({
        locale,
        trackingNumber: '1755021358719',
        statusLabel: 'Out for delivery',
      });

      expect(detectShipmentRefs(draft, defaultPatterns()).trackingNumbers).toEqual([
        '1755021358719',
      ]);
    }
  });

  it('says what the badge said, in the language it was read in', () => {
    expect(
      shipmentChatPrefill({
        locale: 'ar',
        trackingNumber: '1755021358719',
        statusLabel: 'خرجت للتسليم',
      }),
    ).toBe('رقم التتبّع: 1755021358719\nالحالة: خرجت للتسليم\n\n');
  });

  it('carries the number alone when the platform gave no status', () => {
    expect(
      shipmentChatPrefill({ locale: 'en', trackingNumber: '1755021358719', statusLabel: null }),
    ).toBe('Tracking number: 1755021358719\n\n');
  });

  it('ends where the visitor starts typing', () => {
    const draft = shipmentChatPrefill({
      locale: 'en',
      trackingNumber: '1755021358719',
      statusLabel: 'Delivered',
    });

    // A blank line under the facts, so the first thing they type is their own
    // sentence rather than the end of ours — and it survives the `trim()` in
    // `submit`, which only takes the edges.
    expect(draft.endsWith('\n\n')).toBe(true);
    expect(`${draft}Where is it?`.trim().split('\n')).toEqual([
      'Tracking number: 1755021358719',
      'Status: Delivered',
      '',
      'Where is it?',
    ]);
  });
});
