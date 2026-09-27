import { and, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, contacts, messages } from '@/db/schema';
import { enqueueMany, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

const log = logger('backfill_meta_profiles');

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

export async function backfillMetaProfiles(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'backfill_meta_profiles');
  const force = payload.force === true;
  const limit = payload.limit ?? null;

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
          // `::text` on the enum side, not a cast of the JSON side to `channel`.
          // `->>` yields text and `contact_identities.channel` is an enum, so the
          // comparison has no operator without one — `operator does not exist:
          // text = channel`, which is a runtime failure the whole pre-push loop
          // is blind to, since the tests here never touch a database. Casting the
          // JSON to `channel` instead would throw on any value that is not a
          // member of the enum, turning a stray payload into a failed run.
          sql`${messages.meta}->>'platform' = ${contactIdentities.channel}::text`,
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
      // Narrowed by the `inArray` above; the column is typed for every channel.
      platform: row.channel as 'facebook' | 'instagram',
      userId: row.identifier,
      force,
    })),
    // Behind live traffic: a ticket arriving now needs its name before a contact
    // from March does.
    { priority: 200 },
  );

  const breakdown =
    [...tally.entries()].map(([channel, count]) => `${channel} ${count}`).join(', ') || 'none';

  log.info(
    `${rows.length} candidate(s), ${enqueued} enqueued (${breakdown})` +
      `${force ? ' — forced refresh' : ''}`,
  );
}
