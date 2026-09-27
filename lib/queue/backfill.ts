import { gt, type SQL } from 'drizzle-orm';
import { messages } from '@/db/schema';
import type { Logger } from '@/lib/log';

/**
 * Visit every message a backfill selects, a batch at a time.
 *
 * Keyset paging on the primary key, served by its own index. An OFFSET
 * would re-read everything before it on every batch, which on this table is
 * the difference between minutes and hours.
 *
 * On the primary key alone, and deliberately not on (created_at, id): the
 * shipment-link backfill's loop never terminated on that. postgres.js hands a
 * timestamptz back as a JS Date, which holds milliseconds, while the column
 * holds microseconds —
 * so a cursor taken from a row read back through JS is *earlier* than the
 * row itself, the row satisfies its own `created_at > cursor`, and the same
 * batch comes back for ever. Verified on Postgres 16: every row in a seeded
 * table reported `created_at > date_trunc('milliseconds', created_at)` as
 * true. Nothing had caught it because that job had never once been run.
 *
 * The id is a uuid, so the scan is ordered arbitrarily rather than by time.
 * A backfill has no reason to prefer one order, and paging on a value that
 * survives the round trip intact removes the class of bug rather than
 * patching around it.
 *
 * `fetchBatch` runs the backfill's own query — its columns, its predicates —
 * with `after` among its conditions, ordered by `messages.id` ascending and
 * limited to `size`. `after` is undefined for the first batch. `limit` caps how
 * many messages are visited across every batch, the `limit=` a hand-run
 * passes; unset or zero visits them all. Returns how many were visited.
 */
export async function scanMessagesInKeysetOrder<Row extends { id: string }>(
  options: { batchSize: number; limit?: number },
  fetchBatch: (after: SQL | undefined, size: number) => Promise<Row[]>,
  visit: (row: Row) => Promise<void>,
): Promise<number> {
  let cursor: string | null = null;
  let scanned = 0;

  for (;;) {
    const remaining = options.limit ? options.limit - scanned : options.batchSize;
    if (remaining <= 0) break;

    const after = cursor ? gt(messages.id, cursor) : undefined;
    const batch = await fetchBatch(after, Math.min(options.batchSize, remaining));
    if (batch.length === 0) break;

    for (const row of batch) {
      scanned += 1;
      cursor = row.id;
      await visit(row);
    }
  }

  return scanned;
}

/** One figure in a backfill's per-channel table. */
export type TallyColumn<T> = { heading: string; width: number; value: (tally: T) => number };

/**
 * A backfill's figures, one line per channel, sorted by channel.
 *
 * Per channel because that is the dimension a backfill fails along: a total
 * reads as a clean run while hiding "zero from Instagram, ever". Fixed-width so
 * the lines line up in Render's log view, which is where these are read.
 */
export function logChannelTable<T>(
  log: Logger,
  tallies: Map<string, T>,
  columns: TallyColumn<T>[],
): void {
  const header = [
    'channel'.padEnd(14),
    ...columns.map((column) => column.heading.padStart(column.width)),
  ].join('');
  log.info(header);

  for (const [channel, tally] of [...tallies.entries()].sort()) {
    log.info(
      [
        channel.padEnd(14),
        ...columns.map((column) => String(column.value(tally)).padStart(column.width)),
      ].join(''),
    );
  }
}
