/**
 * The windows the satisfaction report offers, in days, shared by the page and
 * its CSV: a range added to the page's switch is then one the export accepts,
 * rather than a file that quietly covers 30 days beside a page covering 14.
 */
export const RANGES = [7, 30, 90] as const;

/** The window a request asked for, or 30 days when it named none on offer. */
export function daysFrom(requested: string | null | undefined): number {
  const days = Number(requested);
  return RANGES.includes(days as (typeof RANGES)[number]) ? days : 30;
}
