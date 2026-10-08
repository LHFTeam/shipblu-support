import { PRIORITIES, type Priority } from '@/lib/tickets/vocabulary';
import type { PriorityAiMode } from './settings';

/**
 * Whether one answer from Jev may change a ticket's priority.
 *
 * Pure, and where this feature's tests live, because every rule in it is a way
 * an automated writer of a column people also write can go wrong — and each one
 * is silent once it has: a ticket quietly downgraded after an agent raised it
 * looks exactly like a ticket nobody raised.
 *
 * Three rules, in the order they are checked:
 *
 * 1. **A priority anybody else chose is never touched.** A person in the
 *    console, an automation rule, a form's default, an agent opening the ticket
 *    on the customer's behalf. `ownedElsewhere` carries the ones with a record;
 *    `expected` catches the rest — if the column no longer holds what this
 *    classifier last left there (or the `medium` default, if it never acted),
 *    somebody moved it without an event, and that is theirs too.
 *
 * 2. **Below the threshold, nothing.** The probability is the winner's own
 *    share, the number a threshold sweep over `ai_priority_runs` is drawn from.
 *
 * 3. **Down only on the ticket's first message; up at any time.** The answer to
 *    the customer's opening message may set any level, `low` included. Every
 *    later message may raise the priority and never lower it. Not "the first
 *    *confident* answer", which is what this said first: a legal threat that
 *    splits its probability between urgent and high is below the threshold, and
 *    the "thanks" after it is the most confident answer a four-way classifier
 *    ever gives — so the first confident answer on a ticket was most often a
 *    `low` for content-free text, lowering exactly the tickets this exists to
 *    raise. Lowering is a judgement about the whole ticket, and only the opening
 *    message is the whole ticket.
 */

export type PriorityOutcome =
  /** Written to the ticket. */
  | 'applied'
  /** Would have been written, in shadow mode. */
  | 'would_apply'
  /** Confident, and already the ticket's priority. */
  | 'unchanged'
  /** Confident, and lower than the ticket's priority on a later message. */
  | 'not_raised'
  /** Not confident enough to act on. */
  | 'below_threshold'
  /** Somebody else owns this ticket's priority. */
  | 'set_by_person'
  /** No answer: the provider refused permanently. */
  | 'failed';

/**
 * The outcomes that judged the ticket: a confident answer about some message on
 * it that set, or confirmed, its level. Once one exists the ticket's opening has
 * been judged, whatever order the jobs ran in, so no other message's answer may
 * lower it (rule 3). `not_raised` is not one: it was refused the lowering it
 * asked for and moved nothing, so counting it would let the opening's own
 * answer be refused or not by which job ran first. Nor is `set_by_person`,
 * which says only that the answer was not allowed to act.
 */
export const CONFIDENT_OUTCOMES = [
  'applied',
  'would_apply',
  'unchanged',
] as const satisfies readonly PriorityOutcome[];

/** The value of the column a ticket is created with (`conversations.priority`). */
export const DEFAULT_PRIORITY: Priority = 'medium';

export type DecisionInput = {
  mode: Exclude<PriorityAiMode, 'off'>;
  predicted: Priority;
  /** The winner's share of the distribution; null when TypeSafe sent none. */
  probability: number | null;
  minProbability: number;
  /** The ticket's priority as read just now. */
  current: Priority;
  /** The level this classifier last wrote to the ticket, or null if it never has. */
  lastApplied: Priority | null;
  /** A person, a rule, a form or an agent-opened ticket chose the priority. */
  ownedElsewhere: boolean;
  /**
   * This is the customer's opening message, and no other message on the ticket
   * has had a confident answer yet — see `CONFIDENT_OUTCOMES`.
   */
  firstMessage: boolean;
};

export type Decision = {
  outcome: Exclude<PriorityOutcome, 'failed'>;
  /** The level to write; set only when `outcome` is `applied`. */
  to: Priority | null;
};

function rankOf(level: Priority): number {
  return PRIORITIES.indexOf(level);
}

export function decide(input: DecisionInput): Decision {
  if (input.ownedElsewhere) return { outcome: 'set_by_person', to: null };

  const expected = input.lastApplied ?? DEFAULT_PRIORITY;
  if (input.current !== expected) return { outcome: 'set_by_person', to: null };

  // A missing probability is not a confident answer. Reading it as 1 would let a
  // payload that dropped a field move a deadline.
  if (input.probability === null || input.probability < input.minProbability) {
    return { outcome: 'below_threshold', to: null };
  }

  if (input.predicted === input.current) return { outcome: 'unchanged', to: null };

  const lowering = rankOf(input.predicted) < rankOf(input.current);
  if (lowering && !input.firstMessage) return { outcome: 'not_raised', to: null };

  return input.mode === 'apply'
    ? { outcome: 'applied', to: input.predicted }
    : { outcome: 'would_apply', to: null };
}
