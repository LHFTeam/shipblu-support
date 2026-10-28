import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueueSnapshot } from '@/lib/reports/live';
import { cairo } from '@/lib/testing/time';
import { RightNow } from './right-now';

/**
 * The Unassigned tile once routing is live: a held ticket is unassigned by
 * design, so the tile names the ones being routed apart from the work nobody
 * has picked up, and turns amber for the second only. Without that, a queue of
 * held tickets reads as a team ignoring its work, and an admin assigns the
 * tickets the router is about to move.
 */

const EMPTY: QueueSnapshot = {
  open: 0,
  pending: 0,
  onHold: 0,
  unassigned: 0,
  routing: 0,
  awaitingFirstReply: 0,
  awaitingReply: 0,
  breached: 0,
  dueWithinHour: 0,
  oldestWaitingSince: null,
};

/** The Unassigned tile's markup: its label, its value and its hint. */
function unassignedTile(queue: Partial<QueueSnapshot>): { value: string; hint: string } {
  const html = renderToStaticMarkup(
    createElement(RightNow, {
      queue: { ...EMPTY, ...queue },
      now: cairo('2026-10-13T12:30'),
      online: 0,
      agentRows: [],
    }),
  );
  const tile = html.slice(
    html.indexOf('Unassigned<'),
    html.indexOf('</div>', html.indexOf('Unassigned<')),
  );
  const paragraphs = [...tile.matchAll(/<p class="([^"]*)">([^<]*)<\/p>/g)];
  return { value: paragraphs[0]![1]!, hint: paragraphs[1]![2]! };
}

const AMBER = 'text-(--color-feedback-warning-fg)';

describe('the Unassigned tile', () => {
  it('keeps its sentences while nothing is being routed', () => {
    expect(unassignedTile({ open: 3 }).hint).toBe('Everything has an owner');

    const waiting = unassignedTile({ open: 3, unassigned: 2 });
    expect(waiting.hint).toBe('Nobody has picked these up');
    expect(waiting.value).toContain(AMBER);
  });

  it('names the tickets being routed apart from the ones nobody has picked up', () => {
    const mixed = unassignedTile({ open: 6, unassigned: 5, routing: 2 });

    expect(mixed.hint).toBe('2 being routed · 3 nobody has picked up');
    expect(mixed.value).toContain(AMBER);
  });

  it('is not amber when every unassigned ticket is being routed', () => {
    const held = unassignedTile({ open: 3, unassigned: 3, routing: 3 });

    expect(held.hint).toBe('Being routed — held until their category settles');
    expect(held.value).not.toContain(AMBER);
  });
});
