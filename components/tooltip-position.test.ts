import { describe, expect, it } from 'vitest';
import { placeTooltip } from './tooltip-position';

/** A desktop console window and a phone, which are the two shapes that matter. */
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const bubble = { width: 240, height: 64 };

describe('placeTooltip', () => {
  it('centres the bubble above the trigger when there is room', () => {
    const trigger = { top: 400, left: 600, width: 16, height: 16 };

    const placed = placeTooltip(trigger, bubble, DESKTOP);

    expect(placed.placement).toBe('top');
    // 400 - 8 gap - 64 tall
    expect(placed.top).toBe(328);
    // centre of the trigger (608) minus half the bubble (120)
    expect(placed.left).toBe(488);
  });

  it('flips below a trigger near the top of the viewport', () => {
    // The first row of an admin table sits under a sticky header; there is no
    // room above it for a two-line bubble.
    const trigger = { top: 40, left: 600, width: 16, height: 16 };

    const placed = placeTooltip(trigger, bubble, DESKTOP);

    expect(placed.placement).toBe('bottom');
    expect(placed.top).toBe(64);
  });

  it('keeps a bubble on the start edge inside the viewport', () => {
    const trigger = { top: 400, left: 4, width: 16, height: 16 };

    const placed = placeTooltip(trigger, bubble, DESKTOP);

    // Centring would put it at -108.
    expect(placed.left).toBe(8);
  });

  it('keeps a bubble on the end edge inside the viewport', () => {
    // The last column of a wide table, which is where the delete action and its
    // explanation live.
    const trigger = { top: 400, left: 1260, width: 16, height: 16 };

    const placed = placeTooltip(trigger, bubble, DESKTOP);

    expect(placed.left).toBe(DESKTOP.width - 8 - bubble.width);
    expect(placed.left + bubble.width).toBeLessThanOrEqual(DESKTOP.width - 8);
  });

  it('pins to the start margin when the bubble is wider than the phone', () => {
    // The clamp range inverts here — min would be above max — and the naive
    // Math.min(Math.max()) would push the bubble off the start edge.
    const wide = { width: 420, height: 64 };
    const trigger = { top: 400, left: 200, width: 16, height: 16 };

    const placed = placeTooltip(trigger, wide, PHONE);

    expect(placed.left).toBe(8);
  });

  it('takes the roomier side when the bubble fits neither', () => {
    const tall = { width: 240, height: 700 };
    // Low in a short viewport: 300px above, 244px below.
    const trigger = { top: 300, left: 200, width: 16, height: 16 };

    const placed = placeTooltip(trigger, tall, { width: 390, height: 560 });

    expect(placed.placement).toBe('top');
    expect(placed.top).toBeGreaterThanOrEqual(8);
  });

  it('never returns a position that starts off-screen', () => {
    // Every corner of a phone, which is where the clamps actually fire.
    const corners = [
      { top: 0, left: 0, width: 16, height: 16 },
      { top: 0, left: PHONE.width - 16, width: 16, height: 16 },
      { top: PHONE.height - 16, left: 0, width: 16, height: 16 },
      { top: PHONE.height - 16, left: PHONE.width - 16, width: 16, height: 16 },
    ];

    for (const trigger of corners) {
      const placed = placeTooltip(trigger, bubble, PHONE);
      expect(placed.left).toBeGreaterThanOrEqual(8);
      expect(placed.top).toBeGreaterThanOrEqual(8);
      expect(placed.left + bubble.width).toBeLessThanOrEqual(PHONE.width - 8);
      expect(placed.top + bubble.height).toBeLessThanOrEqual(PHONE.height - 8);
    }
  });
});
