import type { CategoryAiMode } from '@/lib/category-ai/modes';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';

/**
 * How a channel's new tickets find their group, and the one place that reads
 * a channel's mode (`plans/ticket-category-routing.md`, decision 5).
 *
 * Pure and client-safe, so the channel editor can name the modes without
 * importing the schema: the values are `routingModeEnum`'s, which
 * `mode.test.ts` holds this list to.
 */

export const ROUTING_MODES = ['default_group', 'category_shadow', 'category'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export function isRoutingMode(value: unknown): value is RoutingMode {
  return ROUTING_MODES.some((mode) => mode === value);
}

/** What `startRouting` writes for a new ticket: a live hold, a shadow record, or nothing. */
export type RoutingStart = 'live' | 'shadow';

/**
 * A channel's routing mode as the code must act on it — never the column read
 * directly.
 *
 * `default_group` whatever the column says for two kinds of row:
 *
 * - **a coexistence number**, whose replies are typed on the phone, so routing
 *   its tickets changes nothing about who answers them. `saveChannel` refuses
 *   the mode there and `complete_coexistence_onboarding` resets it on a row it
 *   adopts, so the column agrees; this is what holds if it ever does not.
 * - **a read-only channel** — the bot — whose transcripts are not work, run no
 *   creation pass, and so would be held with nothing to begin them.
 *
 * A value this module does not know reads as `default_group` too: a mode
 * misread is a ticket left where it would have gone before Stage 5, which is
 * the safe side of every mistake here.
 */
export function routingModeOf(channel: {
  type: string;
  config: unknown;
  routingMode: string | null;
}): RoutingMode {
  if (isReadOnlyChannel(channel.type)) return 'default_group';
  if (channel.type === 'whatsapp' && parseCoexistence(channel.config) !== null) {
    return 'default_group';
  }
  return isRoutingMode(channel.routingMode) ? channel.routingMode : 'default_group';
}

/**
 * Whether a new ticket on a channel in `mode` enters routing, live or shadow.
 *
 * Only while the classifier is in `apply`. Off or in shadow, it files no
 * category, so a live hold would wait out every window for nothing and a
 * shadow record would read `fallback` for every ticket: the mode is idle, and
 * the channel page says so.
 */
export function routingStartFor(mode: RoutingMode, classifier: CategoryAiMode): RoutingStart | null {
  if (classifier !== 'apply') return null;
  switch (mode) {
    case 'category':
      return 'live';
    case 'category_shadow':
      return 'shadow';
    case 'default_group':
      return null;
  }
}
