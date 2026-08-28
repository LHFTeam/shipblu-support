import { describe, expect, it } from 'vitest';
import type { conversations } from '@/db/schema';
import { conversationFacts } from '@/lib/rules/facts';
import { matches } from '@/lib/rules/conditions';
import { CLOSE_RESOLVED_RULE } from './defaults';

const NOW = new Date('2026-08-28T09:00:00Z');

/**
 * A ticket resolved `hours` ago, or never.
 *
 * Deliberately routed through `conversationFacts` rather than asserting against
 * a hand-written fact map: the thing most likely to be wrong about a stored rule
 * is the *name* of the fact it reads, and a hand-written map would agree with a
 * typo on both sides. Everything the facts do not read is cast away rather than
 * spelled out — a column this rule depends on and that the fixture omits reads
 * undefined, which is exactly what a misspelt one would read.
 */
function resolvedHoursAgo(
  hours: number | null,
  category: 'open' | 'pending' | 'resolved' | 'closed' = 'resolved',
) {
  const conversation = {
    channel: 'webchat',
    priority: 'medium',
    type: null,
    subject: 'Where is my shipment?',
    tags: [],
    isSpam: false,
    reopenCount: 0,
    customFields: {},
    createdAt: new Date(NOW.getTime() - 10 * 86_400_000),
    resolvedAt: hours === null ? null : new Date(NOW.getTime() - hours * 3_600_000),
  } as unknown as typeof conversations.$inferSelect;

  return conversationFacts({ conversation, statusCategory: category }, NOW);
}

describe('the close-after-3-days rule', () => {
  it('closes a ticket that has been resolved for longer than the window', () => {
    expect(matches(CLOSE_RESOLVED_RULE.conditions, resolvedHoursAgo(73))).toBe(true);
  });

  it('leaves one inside the window alone', () => {
    // The customer still has this long to say we got it wrong, and a reply
    // inside the window reopens the ticket instead of starting a new one.
    expect(matches(CLOSE_RESOLVED_RULE.conditions, resolvedHoursAgo(71))).toBe(false);
  });

  it('closes exactly on the boundary', () => {
    expect(matches(CLOSE_RESOLVED_RULE.conditions, resolvedHoursAgo(72))).toBe(true);
  });

  it('never closes a ticket that is not resolved', () => {
    // A ticket reopened by a customer reply has `resolved_at` nulled, so it must
    // read as "never resolved" and not as "resolved an infinitely long time ago"
    // — the difference between a reopened ticket surviving the sweep and being
    // closed underneath the customer who just wrote in.
    expect(matches(CLOSE_RESOLVED_RULE.conditions, resolvedHoursAgo(null, 'open'))).toBe(false);
    expect(matches(CLOSE_RESOLVED_RULE.conditions, resolvedHoursAgo(200, 'open'))).toBe(false);
  });

  it('is a time-based rule, since nothing a person does can fire it', () => {
    expect(CLOSE_RESOLVED_RULE.trigger).toBe('time_based');
  });
});
