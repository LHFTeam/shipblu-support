import type { CategoryAiMode } from '@/lib/category-ai/modes';
import type { RoutingOutcome } from './decide';
import { routingModeOf, type RoutingMode } from './mode';

/**
 * What the console calls each routing mode and outcome, and the sentences
 * about a mode that more than one screen says: the channel forms,
 * `saveChannel`'s answer, the readiness panel on `/admin/channels` and the
 * routing report.
 *
 * Pure and client-safe, beside `mode.ts`, so the forms can name the modes
 * without importing the schema — and so the editor's disabled control, the
 * action's refusal and the panel's warning give one reason in one wording.
 */

export const ROUTING_MODE_LABELS: Record<RoutingMode, string> = {
  default_group: 'Default group',
  category_shadow: 'By category — shadow',
  category: 'By category',
};

/**
 * Each outcome as a column of `/reports/routing` names it: the timeline's
 * `routed` sentence (`describeRouted` in `lib/tickets/event-labels.ts`)
 * shortened to a heading, so a supervisor who reads "Window ran out" over a
 * column finds "nothing had said what it is about by the end of the routing
 * window" on the tickets counted in it. In `ROUTING_OUTCOMES`' order.
 */
export const ROUTING_OUTCOME_LABELS: Record<RoutingOutcome, string> = {
  taken: 'Already taken',
  not_open: 'No longer open',
  released: 'Channel stopped routing',
  category: 'Routed',
  no_route_for_category: 'No route for its category',
  fallback: 'Window ran out',
  manual: 'A person decided first',
  rule: 'A rule decided first',
};

/** The two kinds of row whose mode the router never acts on. */
export type RoutingLock = 'coexistence' | 'bot';

/**
 * Whether a row can never route, and why — asked of `routingModeOf`, the
 * function the router reads, rather than restated, so the form, the action,
 * the readiness panel and ingest cannot disagree about which rows those are.
 */
export function routingLock(channel: { type: string; config: unknown }): RoutingLock | null {
  if (routingModeOf({ ...channel, routingMode: 'category' }) === 'category') return null;
  // A `whatsapp` row is refused only for its coexistence object; every other
  // refusal is a read-only channel, of which the bot is the one.
  return channel.type === 'whatsapp' ? 'coexistence' : 'bot';
}

export const ROUTING_LOCK_REASONS: Record<RoutingLock, string> = {
  bot: 'The customer bot’s transcripts are not work for the team, so its tickets never route.',
  coexistence:
    'Replies on this number are typed on the phone, so moving its tickets to another group would change nothing about who answers them. It never routes.',
};

/** `routingLock`'s answer as the sentence every screen gives, or null for a row that routes. */
export function routingLockReason(channel: { type: string; config: unknown }): string | null {
  const lock = routingLock(channel);
  return lock ? ROUTING_LOCK_REASONS[lock] : null;
}

/**
 * The warning a category mode earns while the classifier cannot serve it:
 * routing starts only in `apply` (`routingStartFor`), so in either other mode
 * the channel's new tickets go on exactly as on `default_group`.
 */
export function idleRoutingSentence(mode: RoutingMode, classifier: CategoryAiMode): string | null {
  if (mode === 'default_group' || classifier === 'apply') return null;
  const now = classifier === 'off' ? 'off' : 'in Shadow';
  const nothing =
    mode === 'category'
      ? 'new tickets are not held, and start in the default group as before'
      : 'nothing is recorded';
  return `Idle until the category classifier is in Apply on /admin/categories: it is ${now}, so ${nothing}.`;
}
