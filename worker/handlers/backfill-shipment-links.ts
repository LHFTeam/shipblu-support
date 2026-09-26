import { and, asc, eq, gt, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { detectShipmentRefs, shipmentPatterns } from '@/lib/shipments/detect';
import { isLinkableMessage, linkShipmentsFromMessage } from '@/lib/shipments/links';
import { errorMessage } from '@/lib/errors';

/**
 * Finds the tracking numbers and SBIDs already sitting in the archive.
 *
 * The live path only ever sees new messages, so without this every ticket that
 * arrived before the feature stays unlinked — and re-running it is also how a
 * corrected detection pattern reaches history rather than only the future.
 *
 * Idempotent by construction: every write underneath is `onConflictDoNothing`
 * against a natural key, so a second run creates nothing. It goes through the
 * same `linkShipmentsFromMessage` the live path uses, so the two cannot drift
 * into scanning different things — a backfill that produced links the live path
 * never would is a discrepancy nobody would ever explain.
 *
 * It **never deletes**. Narrowing a pattern does not retract earlier links; that
 * is a separate, deliberate prune, and one that must filter on
 * `link_source = 'detected'` so it can never remove an agent's work.
 */

type Payload = {
  /** ISO timestamps bounding which messages are scanned. */
  since?: string;
  until?: string;
  /** Scan only, write nothing. Useful for checking a new pattern's yield. */
  dryRun?: boolean;
  /** Stop after this many messages. Absent means the whole archive. */
  limit?: number;
};

const BATCH = 500;

type ChannelTally = {
  messages: number;
  withBody: number;
  trackingHits: number;
  sbidHits: number;
  linksNew: number;
  accountsNew: number;
};

function emptyTally(): ChannelTally {
  return { messages: 0, withBody: 0, trackingHits: 0, sbidHits: 0, linksNew: 0, accountsNew: 0 };
}

export async function backfillShipmentLinks(job: ClaimedJob): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const patterns = shipmentPatterns();
  const dryRun = payload.dryRun === true;

  const bounds: SQL[] = [];
  if (payload.since) bounds.push(gte(messages.createdAt, new Date(payload.since)));
  if (payload.until) bounds.push(lte(messages.createdAt, new Date(payload.until)));

  // Per channel, not just totalled.
  //
  // `body_text` is written by five different ingest paths with different quirks
  // — Meta bodies can be empty when a message is media-only, the bot channel's
  // transcripts have their own shape — so a single figure like "4,812 links
  // created" would read as a clean run while hiding "zero from Instagram, ever".
  // Channel is the dimension that can fail here, so channel is what this is cut
  // by.
  const tallies = new Map<string, ChannelTally>();
  const failures: string[] = [];

  let cursor: string | null = null;
  let scanned = 0;

  for (;;) {
    const remaining = payload.limit ? payload.limit - scanned : BATCH;
    if (remaining <= 0) break;

    const where = [...bounds];
    // Keyset paging on the primary key, served by its own index. An OFFSET
    // would re-read everything before it on every batch, which on this table is
    // the difference between minutes and hours.
    //
    // On the primary key alone, and deliberately not on (created_at, id): this
    // loop never terminated on that. postgres.js hands a timestamptz back as a
    // JS Date, which holds milliseconds, while the column holds microseconds —
    // so a cursor taken from a row read back through JS is *earlier* than the
    // row itself, the row satisfies its own `created_at > cursor`, and the same
    // batch comes back for ever. Verified on Postgres 16: every row in a seeded
    // table reported `created_at > date_trunc('milliseconds', created_at)` as
    // true. Nothing had caught it because this job has never once been run.
    //
    // The id is a uuid, so the scan is ordered arbitrarily rather than by time.
    // A backfill has no reason to prefer one order, and paging on a value that
    // survives the round trip intact removes the class of bug rather than
    // patching around it.
    if (cursor) where.push(gt(messages.id, cursor));

    const batch = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        kind: messages.kind,
        bodyText: messages.bodyText,
        channel: conversations.channel,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(messages.id))
      .limit(Math.min(BATCH, remaining));

    if (batch.length === 0) break;

    for (const message of batch) {
      scanned += 1;
      cursor = message.id;

      const tally = tallies.get(message.channel) ?? emptyTally();
      tallies.set(message.channel, tally);
      tally.messages += 1;

      if (!isLinkableMessage(message.kind) || !message.bodyText.trim()) continue;
      tally.withBody += 1;

      const found = detectShipmentRefs(message.bodyText, patterns);
      tally.trackingHits += found.trackingNumbers.length;
      tally.sbidHits += found.sbids.length;

      if (dryRun) continue;
      if (found.trackingNumbers.length === 0 && found.sbids.length === 0) continue;

      try {
        const linked = await linkShipmentsFromMessage({
          conversationId: message.conversationId,
          messageId: message.id,
          bodyText: message.bodyText,
          kind: message.kind,
        });
        tally.linksNew += linked.trackingNumbers.length;
        tally.accountsNew += linked.sbids.length;
      } catch (error) {
        // One bad message must not end the run; the rest of the archive is
        // still worth linking, and the run fails at the end with the list.
        failures.push(`${message.id}: ${errorMessage(error)}`);
      }
    }
  }

  report(scanned, tallies, failures, dryRun);

  if (failures.length > 0) {
    throw new Error(`backfill_shipment_links: ${failures.length} message(s) failed`);
  }
}

function report(
  scanned: number,
  tallies: Map<string, ChannelTally>,
  failures: string[],
  dryRun: boolean,
): void {
  const tag = '[backfill_shipment_links]';
  console.log(`${tag} scanned ${scanned} messages (dry_run=${dryRun})`);

  const header = [
    'channel'.padEnd(14),
    'messages'.padStart(9),
    'with_body'.padStart(10),
    'tracking'.padStart(9),
    'sbid'.padStart(6),
    'links_new'.padStart(10),
    'accounts_new'.padStart(13),
  ].join('');
  console.log(`${tag} ${header}`);

  const silent: string[] = [];

  for (const [channel, tally] of [...tallies.entries()].sort()) {
    console.log(
      `${tag} ` +
        [
          channel.padEnd(14),
          String(tally.messages).padStart(9),
          String(tally.withBody).padStart(10),
          String(tally.trackingHits).padStart(9),
          String(tally.sbidHits).padStart(6),
          String(tally.linksNew).padStart(10),
          String(tally.accountsNew).padStart(13),
        ].join(''),
    );

    if (tally.withBody > 0 && tally.trackingHits === 0 && tally.sbidHits === 0) {
      silent.push(channel);
    }
  }

  // The line somebody actually reads. A channel with plenty of message bodies
  // and not one match is either a channel that genuinely never carries a
  // tracking number, or a pattern that does not fit how that channel writes them
  // — and only one of those is fine.
  if (silent.length > 0) {
    console.warn(`${tag} channels with message bodies but no matches at all: ${silent.join(', ')}`);
  }

  if (failures.length > 0) {
    console.error(`${tag} ${failures.length} failure(s); first 20:`);
    for (const failure of failures.slice(0, 20)) console.error(`${tag}   ${failure}`);
  }
}
