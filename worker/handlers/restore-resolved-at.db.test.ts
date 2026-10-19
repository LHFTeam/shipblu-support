import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversationEvents, conversations, ticketStatuses } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { restoreResolvedAt } from './restore-resolved-at';

/**
 * The repair for §6.98, on timelines written by hand: which closed tickets get
 * a resolve back, which instant they get, and which keep their null because
 * nobody resolved them or they were reopened since.
 */

withCleanDatabase();

function job(payload: Record<string, unknown> = {}): ClaimedJob {
  return { id: 'job-1', type: 'restore_resolved_at', payload } as unknown as ClaimedJob;
}

const T = (hour: number) => new Date(Date.UTC(2026, 7, 18, hour, 0, 0, 123));

type Move =
  | { kind: 'status'; category: 'open' | 'pending' | 'resolved' | 'closed'; at: Date }
  | { kind: 'reopened'; at: Date }
  /** A `status_changed` that names its status but records no category. */
  | { kind: 'uncategorised'; at: Date };

/** A ticket now in `statusName`, with no stamp, and the timeline given. */
async function ticket(statusName: string, moves: Move[]): Promise<string> {
  const [statusRow] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, statusName));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .insert(conversations)
    .values({ channel: 'email', statusId: statusRow!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  for (const move of moves) {
    await db.insert(conversationEvents).values({
      conversationId: row!.id,
      createdAt: move.at,
      ...(move.kind === 'reopened'
        ? { type: 'reopened', actorLabel: 'inbound_email', data: { reason: 'customer_replied' } }
        : move.kind === 'uncategorised'
          ? { type: 'status_changed', data: { to: 'Waiting' } }
          : { type: 'status_changed', data: { to: move.category, category: move.category } }),
    });
  }
  return row!.id;
}

const resolve = (at: Date): Move => ({ kind: 'status', category: 'resolved', at });
const close = (at: Date): Move => ({ kind: 'status', category: 'closed', at });

async function resolvedAt(id: string): Promise<string | null> {
  const [row] = await db
    .select({ at: sql<string | null>`${conversations.resolvedAt}::text` })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.at;
}

/** Changes whenever the row is written, whatever the write sets. */
async function rowVersion(id: string): Promise<string> {
  const [row] = await db
    .select({ xmin: sql<string>`xmin::text` })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.xmin;
}

/** An instant as Postgres prints a `timestamptz`, in the test database's zone. */
async function asText(at: Date): Promise<string> {
  const [row] = await db.execute<{ t: string }>(
    sql`SELECT ${at.toISOString()}::timestamptz::text AS t`,
  );
  return row!.t;
}

describe('restore_resolved_at', () => {
  it('gives a ticket closed after a resolve the instant of that resolve', async () => {
    const id = await ticket('Closed', [resolve(T(9)), close(T(12))]);

    await restoreResolvedAt(job());

    expect(await resolvedAt(id)).toBe(await asText(T(9)));
  });

  it('passes over moves into Closed, which keep the stamp now', async () => {
    const closedTwice = await ticket('Closed', [resolve(T(9)), close(T(12)), close(T(13))]);
    const resolvedAgain = await ticket('Closed', [
      resolve(T(9)),
      close(T(10)),
      resolve(T(11)),
      close(T(12)),
    ]);

    await restoreResolvedAt(job());

    expect(await resolvedAt(closedTwice)).toBe(await asText(T(9)));
    expect(await resolvedAt(resolvedAgain)).toBe(await asText(T(11)));
  });

  it('leaves a ticket nobody resolved, or one reopened since its resolve, without one', async () => {
    const ids = [
      // Closed straight from Open — or filed resolved with no event, as a
      // business-app conversation or a copied history is, and closed later.
      await ticket('Closed', [close(T(12))]),
      // Resolved, then the customer wrote back, then an agent closed it.
      await ticket('Closed', [resolve(T(9)), { kind: 'reopened', at: T(10) }, close(T(12))]),
      // Resolved, then moved back to Pending by hand, then closed.
      await ticket('Closed', [
        resolve(T(9)),
        { kind: 'status', category: 'pending', at: T(10) },
        close(T(12)),
      ]),
      // Resolved, then a move that records no category, then closed: it could
      // have been a reopen, so the resolve before it is not restored.
      await ticket('Closed', [resolve(T(9)), { kind: 'uncategorised', at: T(10) }, close(T(12))]),
    ];
    // Not closed: the writers stamp what is still resolved, so nothing here is
    // this job's to repair.
    ids.push(await ticket('Resolved', [resolve(T(9))]));

    await restoreResolvedAt(job());

    for (const id of ids) expect(await resolvedAt(id)).toBeNull();
  });

  it('writes nothing on a dry run, and nothing more on a second run', async () => {
    const id = await ticket('Closed', [resolve(T(9)), close(T(12))]);

    await restoreResolvedAt(job({ dryRun: true }));
    expect(await resolvedAt(id)).toBeNull();

    await restoreResolvedAt(job());
    const version = await rowVersion(id);
    await restoreResolvedAt(job());

    expect(await resolvedAt(id)).toBe(await asText(T(9)));
    // Not written again at all, not merely written with the same value.
    expect(await rowVersion(id)).toBe(version);
  });

  it('refuses a payload it does not know, so a typo is not a run that writes', async () => {
    await expect(restoreResolvedAt(job({ dryrun: true }))).rejects.toThrow();
  });
});
