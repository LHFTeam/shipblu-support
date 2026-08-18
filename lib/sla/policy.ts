import type { SlaEscalation, SlaTarget, SlaTargets } from '@/db/schema/config';
import { addBusinessMinutes, type HoursConfig } from '@/lib/hours';
import { matches, type Facts } from '@/lib/rules/conditions';

/**
 * Choosing a policy and turning its targets into due dates.
 *
 * Split from the database access in `./index` so the part with all the
 * judgement in it — which policy wins, when the clock lands — is testable
 * without a database, and so the sweep can select once and reuse the answer for
 * a whole batch.
 */

export type LoadedPolicy = {
  id: string;
  name: string;
  conditions: unknown;
  targets: SlaTargets;
  escalations: { firstResponse?: SlaEscalation; resolution?: SlaEscalation };
  position: number;
  isDefault: boolean;
  /** Null means round-the-clock: the clock never pauses for out-of-hours. */
  hours: HoursConfig | null;
};

export type Priority = keyof SlaTargets;

export type DueDates = {
  firstResponseDueAt: Date | null;
  nextResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
};

/**
 * First policy whose conditions match, by position; otherwise the default.
 *
 * Ordered-first-match rather than most-specific-wins because that is the rule
 * an admin can predict by looking at the list. "Most specific" requires them to
 * hold the whole set in their head to know what a new policy will capture.
 */
export function selectPolicy(policies: LoadedPolicy[], facts: Facts): LoadedPolicy | null {
  const ordered = [...policies].sort((a, b) => a.position - b.position);

  for (const policy of ordered) {
    if (matches(policy.conditions, facts)) return policy;
  }

  // A default policy applies even when its own conditions did not match: that
  // is what "default" means, and a ticket with no SLA at all is invisible to
  // every report and every breach sweep.
  return ordered.find((policy) => policy.isDefault) ?? null;
}

export function targetFor(policy: LoadedPolicy, priority: Priority): SlaTarget {
  return (
    policy.targets[priority] ?? {
      firstResponseMins: null,
      nextResponseMins: null,
      resolutionMins: null,
    }
  );
}

/**
 * Due dates for a ticket that has just arrived.
 *
 * `nextResponseDueAt` is left unset here: it is the clock on replying to a
 * customer's *follow-up*, and until the first response has happened the first
 * response target is the one that applies. Setting both at creation would show
 * two competing countdowns on a brand new ticket.
 */
export function dueDatesOnCreate(policy: LoadedPolicy, priority: Priority, from: Date): DueDates {
  const target = targetFor(policy, priority);

  return {
    firstResponseDueAt: dueAt(policy, target.firstResponseMins, from),
    nextResponseDueAt: null,
    resolutionDueAt: dueAt(policy, target.resolutionMins, from),
  };
}

/**
 * When a reply to the customer's latest message is due.
 *
 * Falls back to the first-response target when no next-response target is
 * configured, which is the common case: most teams set one number and mean it
 * for every reply.
 */
export function nextResponseDueAt(
  policy: LoadedPolicy,
  priority: Priority,
  from: Date,
): Date | null {
  const target = targetFor(policy, priority);
  return dueAt(policy, target.nextResponseMins ?? target.firstResponseMins, from);
}

/**
 * Adds a target to an instant, in working time when the policy has business
 * hours and in wall-clock time when it does not.
 *
 * A null target means "no commitment on this dimension" and must stay null
 * rather than becoming "due immediately" — an absent target that reads as a
 * breach would put every ticket in the breached bucket the moment a policy is
 * half-configured.
 */
export function dueAt(policy: LoadedPolicy, minutes: number | null, from: Date): Date | null {
  if (minutes === null || minutes === undefined) return null;
  if (!Number.isFinite(minutes) || minutes < 0) return null;

  if (!policy.hours) return new Date(from.getTime() + minutes * 60_000);

  return addBusinessMinutes(policy.hours, from, minutes);
}
