/**
 * Where a tooltip bubble goes, given what it is describing.
 *
 * Split out from the component and kept pure because this is the half that can
 * be wrong in ways nobody notices until a customer does: the "cap" tooltip on
 * the first agent row opens against the top of the viewport, the one on the
 * last column of a wide table opens against the right edge, and a phone is
 * narrower than the bubble's own maximum width. All three are arithmetic, and
 * arithmetic can be tested without a browser.
 *
 * Coordinates are viewport coordinates — what `getBoundingClientRect()` returns
 * and what `position: fixed` consumes — so nothing here needs to know about
 * scroll offsets or which ancestor is clipping.
 */

export type Rect = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Placement = 'top' | 'bottom';
export type Placed = { left: number; top: number; placement: Placement };

/** Between the trigger and the bubble. Enough that the bubble is not read as part of the control. */
const GAP = 8;
/** Between the bubble and the edge of the viewport. */
const MARGIN = 8;

export function placeTooltip(
  trigger: Rect,
  bubble: Size,
  viewport: Size,
  options: { gap?: number; margin?: number } = {},
): Placed {
  const gap = options.gap ?? GAP;
  const margin = options.margin ?? MARGIN;

  const above = trigger.top - gap - bubble.height;
  const below = trigger.top + trigger.height + gap;

  /*
   * Above by default, because a tooltip below the control covers the next row
   * of a settings form — which is often the thing the reader is comparing it
   * against. It flips below only when it genuinely does not fit above.
   */
  let placement: Placement;
  if (above >= margin) {
    placement = 'top';
  } else if (below + bubble.height <= viewport.height - margin) {
    placement = 'bottom';
  } else {
    // Neither side fits: take the roomier one and let the clamp below pull the
    // bubble back into view. A bubble half off the screen still reads; one
    // pinned to a side with no room at all does not.
    const roomAbove = trigger.top;
    const roomBelow = viewport.height - (trigger.top + trigger.height);
    placement = roomAbove > roomBelow ? 'top' : 'bottom';
  }

  const top = clamp(
    placement === 'top' ? above : below,
    margin,
    Math.max(margin, viewport.height - margin - bubble.height),
  );

  // Centred on the trigger, then pulled inside the viewport. The `Math.max`
  // guards the case where the bubble is wider than the space between the
  // margins — on a narrow phone the clamp range inverts, and without it the
  // bubble would be pushed off the start edge instead of the end.
  const centred = trigger.left + trigger.width / 2 - bubble.width / 2;
  const left = clamp(centred, margin, Math.max(margin, viewport.width - margin - bubble.width));

  return { left: Math.round(left), top: Math.round(top), placement };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
