/**
 * The category options a picker offers, from rows already in hand.
 *
 * Client-safe, with no import from `db/`, so the sidebar, the inbox filter and
 * the rule builders can share it — the same split `lib/forms/files.ts` makes.
 */
export type CategoryChoice = { id: string; labelEn: string; isActive: boolean };

/**
 * Active categories in the admin's order, and the one a ticket or a rule
 * already holds even when it has been retired since — named as retired, so the
 * control shows what is stored rather than a blank that reads as "none", and
 * so saving the form unchanged does not silently clear it.
 */
export function categoryOptions(
  categories: readonly CategoryChoice[],
  current: string | null,
): { value: string; label: string }[] {
  return categories
    .filter((category) => category.isActive || category.id === current)
    .map((category) => ({
      value: category.id,
      label: category.isActive ? category.labelEn : `${category.labelEn} (retired)`,
    }));
}
