/**
 * The category options a picker offers, from rows already in hand.
 *
 * Client-safe, with no import from `db/`, so the sidebar, the inbox filter and
 * the rule builders can share it — the same split `lib/forms/files.ts` makes.
 */
export type CategoryChoice = { id: string; labelEn: string; isActive: boolean };

/**
 * Registry rows cut to a `CategoryChoice`, for a client component's props.
 *
 * A prop typed `CategoryChoice[]` accepts a whole registry row, because a
 * variable is checked structurally, and React then serialises every field it
 * was handed: the Arabic label, the description written for Jev, the route
 * group. None of that is the browser's business, so every page passing the
 * registry to a client component passes it through this.
 */
export function toCategoryChoices(rows: readonly CategoryChoice[]): CategoryChoice[] {
  return rows.map(({ id, labelEn, isActive }) => ({ id, labelEn, isActive }));
}

/**
 * A category's name as anything outside its own admin page draws it: marked
 * when it has been retired, so a ticket or a rule still holding one says so
 * rather than reading as a live choice.
 */
export function categoryLabel(labelEn: string, isActive: boolean): string {
  return isActive ? labelEn : `${labelEn} (retired)`;
}

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
      label: categoryLabel(category.labelEn, category.isActive),
    }));
}
