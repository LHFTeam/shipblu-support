/**
 * The fixed words a ticket is described in: its priority, and the category its
 * status rolls up to.
 *
 * Copies of the `priority` and `status_category` enums in `db/schema/enums.ts`
 * rather than reads of them, because a client form lists these and `db/schema`
 * must never reach a client bundle (§6.57). The test beside this file holds each
 * list equal to its enum, so a value added to the database without being added
 * here fails a test instead of being refused by every form that checks it.
 *
 * The roles are not here: `ROLES_BY_SENIORITY` in `lib/auth/permissions.ts`
 * already lists them, in the order a picker reads them in, and is held to its
 * enum by the same test.
 */

/** Least to most pressing, which is the order a picker lists them in. */
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * What an admin screen calls each priority. A record rather than a list, so a
 * priority added to `PRIORITIES` without a label here fails to compile rather
 * than rendering a blank option in every picker.
 */
const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/** The priorities as picker options, least pressing first. */
export const PRIORITY_CHOICES = PRIORITIES.map((value) => ({
  value,
  label: PRIORITY_LABELS[value],
}));

export const STATUS_CATEGORIES = ['open', 'pending', 'resolved', 'closed'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export function isPriority(value: unknown): value is Priority {
  return (PRIORITIES as readonly unknown[]).includes(value);
}

export function isStatusCategory(value: unknown): value is StatusCategory {
  return (STATUS_CATEGORIES as readonly unknown[]).includes(value);
}
