import { revalidatePath } from 'next/cache';
import type { ActionState } from '@/lib/http/action-state';

/**
 * What the admin settings actions share, in a plain module because they are
 * not actions: a `'use server'` file may export only async functions, each of
 * them a public endpoint, so neither a helper nor a constant can live in one
 * and be imported by another.
 *
 * The actions themselves live beside the page each one serves, in that
 * directory's `actions.ts`. They were one file, `settings-actions.ts`, until
 * the refactor's Stage 5.1 split it by domain, and two rules ran through all
 * of it that still run through every one of them. Conditions and actions are
 * validated with the same parsers the engines use, so a rule that saves is a
 * rule that will run — the alternative is an admin form that accepts something
 * the sweep then silently ignores. And anything a ticket points at is
 * deactivated rather than deleted when it is in use, because deleting it would
 * either orphan the ticket or take it with it.
 */

export type SettingsState = ActionState;

/**
 * What the agents, channels, import and categories actions answer: the error,
 * and for an invite, which of its two deliveries happened. Built on
 * `ActionState` so a success can carry the nonce a form clears itself on.
 */
export type AdminState = ActionState & {
  inviteUrl?: string;
  /**
   * The address an invitation was *queued* for, present only when it was.
   *
   * Named for the queue rather than the send because that is all this action
   * can honestly report: the worker still has to run, and Postmark still has
   * to accept the recipient. Distinct from `inviteUrl`, which comes back
   * either way — the admin has to be told which of the two happened, because
   * "it is on its way" and "nothing was sent, send this yourself" call for
   * opposite next actions.
   */
  inviteQueuedFor?: string;
  /**
   * What a successful write wants the admin to read before the page re-renders
   * — "stored the token; connecting the number now", "asked the phone for its
   * contacts". A success with nothing to say omits it. Separate from `error`,
   * because a form keyed on the nonce clears itself on a success and the
   * sentence has to survive that: it is rendered from the state, not the form.
   */
  notice?: string;
  /**
   * The attempt a successful connect started, so the client that started it
   * can tell its own progress card from another number's on the same page.
   */
  onboardingId?: string;
  /**
   * On a refusal from connecting a number: running Meta's window again would
   * end the same way — the rate limit, or an attempt on this number still
   * live — so the card stops offering it. Read off the answer rather than out
   * of its wording, because each run of the window unlinks the phone's linked
   * devices again.
   */
  wait?: true;
};

export function refresh(path: string) {
  revalidatePath(path);
}

/**
 * What a save answers when the row it names cannot exist. Every admin settings
 * save and delete takes the row's `id` from the form, and passing it straight to a query
 * turned a malformed one into a 22P02 thrown out of the action — a blank crash
 * where the form promises a sentence. An empty id on a save still means "create".
 */
export const GONE = 'That no longer exists — reload the page and try again';
