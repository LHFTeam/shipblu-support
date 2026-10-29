import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

const log = logger('restore_resolved_at');

type Restorable = { number: number; resolved_at: string };

/**
 * Gives a closed ticket back the resolve its close erased.
 *
 * Until `resolveStamp`, closing a resolved ticket cleared `resolved_at`
 * (docs/PROJECT-STATE.md §6.98), so every ticket the seeded rule closed lost
 * the resolution the rollups count it by, the first time its day was
 * recomputed after the close. The writers keep it now; this puts it back on
 * the tickets closed before they did.
 *
 * The instant comes from the ticket's own timeline. Of the events that moved it
 * into a status — a `status_changed`, or a customer's `reopened`, which is a
 * move to Open written with no `status_changed` of its own — the newest that is
 * not a close decides: a resolve is the resolve the close followed, and its
 * instant is restored; a move to Open or Pending means it was reopened since,
 * and a ticket with none was never resolved by anybody (closed straight from
 * Open, or a WhatsApp Business app conversation or a copied history, which are
 * filed resolved with no `resolved_at` on purpose). Those keep their null. Moves
 * into Closed are passed over, because a close keeps the stamp now and so says
 * nothing about it. A `status_changed` that records no category is not passed
 * over: nothing says it was a close, so it decides, and it is not a resolve, so
 * the ticket keeps its null rather than getting back a resolve that move may
 * have undone.
 *
 * The event's instant is the column's to within the request, not to the
 * microsecond: `changeStatus` stamps the column from the server's clock as it
 * builds the update, and its event once that update holds the ticket's row
 * lock (`CHANGE_STAMP`), so the event follows the column by at most the request
 * and any wait on that lock; `set_status` writes its event just after its
 * update. It falls on the same reporting day except within a moment of
 * midnight.
 *
 * Hand-run and safe to run again: a restored ticket is no longer null, so a
 * second run finds nothing, and the update re-checks the row it read, so a
 * ticket moved out of Closed in between is left alone. `dryRun` reports the
 * tickets and instants and writes nothing.
 */
export async function restoreResolvedAt(job: ClaimedJob): Promise<void> {
  const { dryRun = false } = parseJobPayload(job, 'restore_resolved_at');

  const restorable = sql`
    SELECT c.id, c.number, c.status_id, last.created_at
    FROM conversations c
    JOIN ticket_statuses s ON s.id = c.status_id
    CROSS JOIN LATERAL (
      SELECT e.type, e.data ->> 'category' AS category, e.created_at
      FROM conversation_events e
      WHERE e.conversation_id = c.id
        AND (
          e.type = 'reopened'
          OR (e.type = 'status_changed' AND e.data ->> 'category' IS DISTINCT FROM 'closed')
        )
      ORDER BY e.created_at DESC
      LIMIT 1
    ) last
    WHERE s.category = 'closed'
      AND c.resolved_at IS NULL
      AND last.type = 'status_changed'
      AND last.category = 'resolved'
  `;

  const rows = await db.execute<Restorable>(
    dryRun
      ? sql`SELECT r.number, r.created_at::text AS resolved_at FROM (${restorable}) r ORDER BY r.number`
      : sql`
          WITH restorable AS (${restorable}),
          restored AS (
            UPDATE conversations c
            SET resolved_at = r.created_at
            FROM restorable r
            WHERE c.id = r.id AND c.status_id = r.status_id AND c.resolved_at IS NULL
            RETURNING c.number, c.resolved_at
          )
          SELECT number, resolved_at::text AS resolved_at FROM restored ORDER BY number
        `,
  );

  for (const row of rows) {
    log.info(
      `#${row.number}: resolved_at ${dryRun ? 'would be' : 'restored to'} ${row.resolved_at}`,
    );
  }
  log.info(
    `${dryRun ? 'dry run: ' : ''}${rows.length} closed ${rows.length === 1 ? 'ticket' : 'tickets'} ${dryRun ? 'would get' : 'got'} their resolve back`,
  );
}
