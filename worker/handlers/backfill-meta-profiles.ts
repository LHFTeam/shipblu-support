import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, contacts } from '@/db/schema';
import { enqueue, type ClaimedJob } from '@/lib/queue';

/**
 * Names the Facebook and Instagram customers already in the archive.
 *
 * The live path only ever sees a new message, so without this every ticket
 * filed before the lookup existed keeps its bare numeric id — and those are the
 * tickets an agent is most likely to be reading, because they are the ones with
 * history. Re-runnable by design: `npm run job -- backfill_meta_profiles`.
 *
 * It enqueues rather than calling Graph itself. One job per contact means one
 * customer's private profile cannot end the run for everybody behind them, the
 * queue's own retry and dead-letter handling applies, and the work goes through
 * exactly the same handler the live path uses — a backfill that could produce a
 * different answer from the live path is a discrepancy nobody would explain.
 */

type Payload = {
  /** Re-read profiles already on file, rather than only the ones never asked. */
  force?: unknown;
  /** Stop after this many contacts. Absent means all of them. */
  limit?: unknown;
};

export async function backfillMetaProfiles(job: ClaimedJob): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const force = payload.force === true;
  const limit = typeof payload.limit === 'number' && payload.limit > 0 ? payload.limit : null;

  const candidates = db
    .select({
      contactId: contactIdentities.contactId,
      channel: contactIdentities.channel,
      identifier: contactIdentities.identifier,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(
      and(
        inArray(contactIdentities.channel, ['facebook', 'instagram']),
        // A merged-away contact is a tombstone; naming it would put the name on
        // a record no ticket points at any more.
        isNull(contacts.deletedAt),
        ...(force
          ? []
          : [
              isNull(contactIdentities.profileFetchedAt),
              or(isNull(contacts.name), eq(contacts.name, '')),
            ]),
      ),
    )
    .orderBy(contactIdentities.channel, contactIdentities.identifier);

  const rows = limit ? await candidates.limit(limit) : await candidates;

  // Cut by platform, not just totalled. The two reach different Graph endpoints
  // under different product permissions, so "220 enqueued" would read as a clean
  // run while hiding that Instagram produced nothing at all — the exact shape of
  // silent failure `AGENTS.md` asks to break counts down along.
  const tally = new Map<string, number>();
  let enqueued = 0;

  for (const row of rows) {
    const id = await enqueue(
      'fetch_meta_profile',
      { contactId: row.contactId, platform: row.channel, userId: row.identifier, force },
      {
        // Behind live traffic: a ticket arriving now needs its name before a
        // contact from March does.
        priority: 200,
        dedupeKey: `fetch_meta_profile:${row.channel}:${row.identifier}`,
      },
    );

    if (id) {
      enqueued += 1;
      tally.set(row.channel, (tally.get(row.channel) ?? 0) + 1);
    }
  }

  const breakdown =
    [...tally.entries()].map(([channel, count]) => `${channel} ${count}`).join(', ') || 'none';

  console.log(
    `[backfill_meta_profiles] ${rows.length} candidate(s), ${enqueued} enqueued (${breakdown})` +
      `${force ? ' — forced refresh' : ''}`,
  );
}
