/**
 * A row of a poll after a cursor (`afterStatement` in `lib/api/tickets.ts`):
 * which half of the statement it came from, and its place in the thread.
 */
export type AfterRow = {
  /** From the half after the cursor, rather than the overlap at or before it. */
  fresh: boolean;
  /**
   * `created_at` to the microsecond, as fixed-width digits in UTC
   * (`YYYYMMDDHH24MISSUS`), so text order is time order. Not `cursorTime`,
   * whose fraction Postgres prints without its trailing zeros, and not the
   * `Date`, which keeps milliseconds: two rows a few microseconds apart would
   * tie, and the id would decide an order Postgres does not keep.
   */
  placeTime: string;
  /** Lower-case, as Postgres prints a uuid, so text order is the uuid's own. */
  id: string;
};

function byPlace(a: AfterRow, b: AfterRow): number {
  if (a.placeTime !== b.placeTime) return a.placeTime < b.placeTime ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * The page a poll after a cursor answers, from the rows of both halves in
 * whatever order they came: the newest of the overlap, in the room the fresh
 * rows leave short of the page's last place, then the fresh rows, ascending by
 * `(created_at, id)`; and the newest fresh row, which the next cursor names.
 *
 * Sorted here rather than trusted to the statement. Each half has its own
 * `ORDER BY`, but `UNION ALL` promises no order across them or within them, and
 * a Parallel Append or a plan Postgres picks next year can interleave the two:
 * read in the order it came, the cursor could step back to a row already
 * answered and the next poll hand the same rows over again, or the overlap's
 * room go to its oldest rows. Fifty rows at most, so the sort costs nothing.
 */
export function afterPage<R extends AfterRow>(
  rows: readonly R[],
  limit: number,
): { page: R[]; newest: R | undefined } {
  const ordered = [...rows].sort(byPlace);
  const fresh = ordered.filter((row) => row.fresh);
  const overlap = ordered.filter((row) => !row.fresh);
  const room = Math.max(limit - 1 - fresh.length, 0);
  // `slice(-0)` is the whole array, so no room is spelled out.
  const kept = room === 0 ? [] : overlap.slice(-room);
  return { page: [...kept, ...fresh], newest: fresh.at(-1) };
}
