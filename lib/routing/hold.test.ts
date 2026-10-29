import { describe, expect, it } from 'vitest';
import { ROUTING_GRACE_MS, isHeld, windowEndsAt, type HoldColumns } from './hold';

/**
 * The hold, over the ticket's own columns (`plans/ticket-category-routing.md`,
 * decision 5): what assignment, the out-of-hours reply, the sweep and the
 * inbox's "Routing…" badge all ask of one row.
 */

const MINUTE = 60_000;
const WINDOW_ENDS = new Date('2026-10-21T20:05:00.000Z');

/** A ticket in its window: opened, undecided, unassigned. */
const held: HoldColumns = {
  routingWindowEndsAt: WINDOW_ENDS,
  routingDecidedAt: null,
  assigneeAgentId: null,
};

const after = (ms: number) => new Date(WINDOW_ENDS.getTime() + ms);

describe('isHeld, the four conditions', () => {
  it('holds a ticket in its window', () => {
    expect(isHeld(held, after(-4 * MINUTE))).toBe(true);
  });

  it('holds nothing that never entered routing', () => {
    expect(isHeld({ ...held, routingWindowEndsAt: null }, after(-4 * MINUTE))).toBe(false);
  });

  it('holds nothing once decided, however early', () => {
    expect(isHeld({ ...held, routingDecidedAt: after(-4 * MINUTE) }, after(-4 * MINUTE))).toBe(
      false,
    );
  });

  it('holds nothing somebody holds, whoever gave it to them', () => {
    expect(isHeld({ ...held, assigneeAgentId: 'agent-amr' }, after(-4 * MINUTE))).toBe(false);
  });

  it('lets go once the grace past the window has run out', () => {
    expect(isHeld(held, after(ROUTING_GRACE_MS + MINUTE))).toBe(false);
  });
});

describe('isHeld, the grace', () => {
  it('is ten minutes', () => {
    expect(ROUTING_GRACE_MS).toBe(10 * MINUTE);
  });

  it('still holds at the instant settle_routing becomes due', () => {
    // The point of the grace: a sweep at the window's end must not assign the
    // ticket in its default group just as the router moves it.
    expect(isHeld(held, WINDOW_ENDS)).toBe(true);
    expect(isHeld(held, after(1))).toBe(true);
  });

  it('holds up to the last millisecond before window + 10 minutes', () => {
    expect(isHeld(held, after(ROUTING_GRACE_MS - 1))).toBe(true);
  });

  it('has let go exactly at window + 10 minutes', () => {
    expect(isHeld(held, after(ROUTING_GRACE_MS))).toBe(false);
  });
});

describe('windowEndsAt', () => {
  it('counts the window from the instant given', () => {
    const now = new Date('2026-10-21T20:00:00.000Z');
    expect(windowEndsAt(now, 5)).toEqual(WINDOW_ENDS);
    expect(windowEndsAt(now, 30)).toEqual(new Date('2026-10-21T20:30:00.000Z'));
  });
});
