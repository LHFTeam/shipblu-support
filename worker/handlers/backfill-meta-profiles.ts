import { and, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, contacts, messages } from '@/db/schema';
import { enqueueMany, type ClaimedJob } from '@/lib/queue';

/**
 * Names the Facebook and Instagram customers already in the archive.
 *
 * The live path only ever sees a new message, so without this every ticket
 * filed before the lookup existed keeps its bare numeric id — and those are the
 * tickets an agent is most likely to be reading, because they are the ones with
 * history. Re-runnable by design:
 *
 *     npm run job -- backfill_meta_profiles
 *     npm run job -- backfill_meta_profiles force=true limit=50
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

  /*
    Direct-message senders only, which is why this reaches into `messages`
    rather than taking every Meta identity there is.

    `ingestMetaComment` resolves comment authors into the very same
    `(channel, identifier)` namespace — including a synthetic `unknown:<id>`
    when the payload carried no author id at all — and a comment author's id is
    not the page-scoped id the User Profile API answers for. Asking about one
    earns a 100/33, which `isProfilePermissionRefusal` reports as "the app may
    not hold Business Asset User Profile Access". That sentence is the whole
    diagnostic value of this feature and it has to stay trustworthy, so the
    backfill must exclude exactly what `queueProfileLookup` excludes.
  */
  const isDirectMessageSender = exists(
    db
      .select({ one: sql`1` })
      .from(messages)
      .where(
        and(
          eq(messages.fromAddress, contactIdentities.identifier),
          eq(messages.direction, 'inbound'),
          sql`${messages.meta}->>'metaKind' = 'direct_message'`,
          sql`${messages.meta}->>'platform' = ${contactIdentities.channel}`,
        ),
      ),
  );

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
        isDirectMessageSender,
        // "Never asked", and only that — the same condition `needsChannelProfile`
        // uses. Adding "and has no name" would skip a contact whose handle
        // arrived in the webhook but whose picture never did, which on Instagram
        // is the common case.
        ...(force ? [] : [isNull(contactIdentities.profileFetchedAt)]),
      ),
    )
    .orderBy(contactIdentities.channel, contactIdentities.identifier);

  const rows = limit ? await candidates.limit(limit) : await candidates;

  // Cut by platform, not just totalled. The two reach different Graph endpoints
  // under different product permissions, so "220 enqueued" would read as a clean
  // run while hiding that Instagram produced nothing at all — the exact shape of
  // silent failure `AGENTS.md` asks to break counts down along.
  const tally = new Map<string, number>();
  for (const row of rows) tally.set(row.channel, (tally.get(row.channel) ?? 0) + 1);

  // One insert rather than one per row: at `force` over a grown archive the
  // loop-and-await version is thousands of sequential round trips.
  const enqueued = await enqueueMany(
    'fetch_meta_profile',
    rows.map((row) => ({
      contactId: row.contactId,
      platform: row.channel,
      userId: row.identifier,
      force,
    })),
    // Behind live traffic: a ticket arriving now needs its name before a contact
    // from March does.
    { priority: 200 },
  );

  const breakdown =
    [...tally.entries()].map(([channel, count]) => `${channel} ${count}`).join(', ') || 'none';

  console.log(
    `[backfill_meta_profiles] ${rows.length} candidate(s), ${enqueued} enqueued (${breakdown})` +
      `${force ? ' — forced refresh' : ''}`,
  );
}
