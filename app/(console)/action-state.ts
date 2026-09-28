import type { ActionState as BaseActionState } from '@/lib/http/action-state';

/**
 * Console write actions.
 *
 * All of them follow the same shape: authorise, write the row, record an audit
 * event, and enqueue any outbound work. Delivery never happens inline — the
 * agent's reply is saved and visible before a provider is contacted, so an
 * outage delays the send instead of losing what they wrote.
 *
 * They live in one file per domain beside this one (`reply-actions.ts`,
 * `ticket-actions.ts` and the rest), and this is the state every one of them
 * answers with. It is a plain module because the action files and the
 * components that call them all need it: kept in one action file, it made
 * every other action file import from a `'use server'` module to name a type.
 */

export type ActionState = BaseActionState & {
  /**
   * What happened, when succeeding quietly would leave the agent guessing.
   * Most actions change something visible on the page and need none; a profile
   * refresh whose whole output is Meta's answer needs one.
   */
  message?: string;
};
