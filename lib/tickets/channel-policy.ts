import type { conversations } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';

/**
 * What the team may do with a conversation, decided by its channel.
 *
 * One module rather than a `channel === 'whatsapp_bot'` test at each of the ten
 * places that need it — the inbox query, the ticket query, the counts, the
 * server-action re-check, the three composer actions, the composer itself, the
 * filter and the rollup. A rule spread across ten files is a rule that will be
 * enforced in nine of them after the next change.
 *
 * Typed against the channel enum so a mistyped channel name is a compile error
 * rather than a rule that silently never matches.
 */

export type ConversationChannel = (typeof conversations.$inferSelect)['channel'];

/**
 * Channels the inbox can be filtered to.
 *
 * Here rather than beside the inbox queries because the filter dropdown is a
 * client component: importing a *value* from the query module pulls `db/client`
 * — and with it the Postgres driver and `fs` — into the browser bundle, which
 * fails the build. Types are erased and can be imported from anywhere; values
 * cannot.
 *
 * One list, so the dropdown is built from exactly what the parser accepts. They
 * drifted apart once already and Facebook and Instagram spent a phase silently
 * resetting themselves to "all channels".
 */
export const FILTERABLE_CHANNELS = [
  'email',
  'whatsapp',
  'webchat',
  'facebook',
  'instagram',
  'whatsapp_bot',
] as const satisfies readonly ConversationChannel[];

export type FilterableChannel = (typeof FILTERABLE_CHANNELS)[number];

/**
 * Channels the platform only observes.
 *
 * A read-only channel is one whose messages are not ours: another service owns
 * the number and holds the conversation, and we receive a copy of both sides.
 * Writing into it would put a message in front of a customer part-way through
 * someone else's flow, from a number whose replies we do not receive.
 */
const READ_ONLY: readonly ConversationChannel[] = ['whatsapp_bot'];

/** Channels hidden unless the agent holds `ticket.view.bot`. */
const RESTRICTED: readonly ConversationChannel[] = ['whatsapp_bot'];

export function isReadOnlyChannel(channel: string): boolean {
  return (READ_ONLY as readonly string[]).includes(channel);
}

export function isRestrictedChannel(channel: string): boolean {
  return (RESTRICTED as readonly string[]).includes(channel);
}

/**
 * The restricted channels this agent may not see. Empty for an admin.
 *
 * The permission question: may this person ever open one of these at all.
 */
export function hiddenChannels(agent: SessionAgent): ConversationChannel[] {
  return can(agent, 'ticket.view.bot') ? [] : [...RESTRICTED];
}

/**
 * Every restricted channel, whoever is asking.
 *
 * A separate question from `hiddenChannels`, and the two are easy to confuse.
 * That one is about permission. This one is about the inbox being a working
 * queue: a restricted channel is opt-in, absent from "all channels" even for an
 * admin who is allowed to see it, and reached by choosing it in the filter.
 *
 * Without that, one number the team does not answer put nineteen hundred
 * transcripts in front of the two tickets that were actually waiting.
 */
export function restrictedChannels(): ConversationChannel[] {
  return [...RESTRICTED];
}

export function canSeeChannel(agent: SessionAgent, channel: string): boolean {
  return !isRestrictedChannel(channel) || can(agent, 'ticket.view.bot');
}

/**
 * Why a channel cannot be written to, phrased for the agent looking at it.
 *
 * A sentence rather than a boolean, so the composer and the server actions say
 * the same thing — an agent told one thing by the screen and another by the
 * action they just took would reasonably conclude something is broken.
 */
export function readOnlyReason(channel: string): string | null {
  if (!isReadOnlyChannel(channel)) return null;
  return 'This conversation belongs to the customer bot, which runs outside this platform. It is here to be read, not answered — sending from this number would interrupt the bot mid-flow.';
}

/**
 * The read-only channels, for excluding them from a query.
 *
 * Three places need this and all three need it for the same underlying reason —
 * nobody on the team is working these conversations. The SLA sweep would raise
 * breaches nobody can clear, a time-based rule would auto-reply into somebody
 * else's flow, and reporting would average a first response that never comes
 * into the figures for the ones that do.
 */
export function readOnlyChannels(): ConversationChannel[] {
  return [...READ_ONLY];
}
