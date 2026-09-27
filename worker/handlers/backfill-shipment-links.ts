import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logChannelTable, scanMessagesInKeysetOrder } from '@/lib/queue/backfill';
import { detectShipmentRefs, shipmentPatterns } from '@/lib/shipments/detect';
import { isLinkableMessage, linkShipmentsFromMessage } from '@/lib/shipments/links';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

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
  const payload = parseJobPayload(job, 'backfill_shipment_links');
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

  const scanned = await scanMessagesInKeysetOrder(
    { batchSize: BATCH, limit: payload.limit },
    (after, size) =>
      db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          kind: messages.kind,
          bodyText: messages.bodyText,
          channel: conversations.channel,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(...bounds, after))
        .orderBy(asc(messages.id))
        .limit(size),
    async (message) => {
      const tally = tallies.get(message.channel) ?? emptyTally();
      tallies.set(message.channel, tally);
      tally.messages += 1;

      if (!isLinkableMessage(message.kind) || !message.bodyText.trim()) return;
      tally.withBody += 1;

      const found = detectShipmentRefs(message.bodyText, patterns);
      tally.trackingHits += found.trackingNumbers.length;
      tally.sbidHits += found.sbids.length;

      if (dryRun) return;
      if (found.trackingNumbers.length === 0 && found.sbids.length === 0) return;

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
    },
  );

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
  const log = logger('backfill_shipment_links');
  log.info(`scanned ${scanned} messages (dry_run=${dryRun})`);

  logChannelTable(log, tallies, [
    { heading: 'messages', width: 9, value: (tally) => tally.messages },
    { heading: 'with_body', width: 10, value: (tally) => tally.withBody },
    { heading: 'tracking', width: 9, value: (tally) => tally.trackingHits },
    { heading: 'sbid', width: 6, value: (tally) => tally.sbidHits },
    { heading: 'links_new', width: 10, value: (tally) => tally.linksNew },
    { heading: 'accounts_new', width: 13, value: (tally) => tally.accountsNew },
  ]);

  const silent: string[] = [];

  for (const [channel, tally] of [...tallies.entries()].sort()) {
    if (tally.withBody > 0 && tally.trackingHits === 0 && tally.sbidHits === 0) {
      silent.push(channel);
    }
  }

  // The line somebody actually reads. A channel with plenty of message bodies
  // and not one match is either a channel that genuinely never carries a
  // tracking number, or a pattern that does not fit how that channel writes them
  // — and only one of those is fine.
  if (silent.length > 0) {
    log.warn(`channels with message bodies but no matches at all: ${silent.join(', ')}`);
  }

  if (failures.length > 0) {
    log.error(`${failures.length} failure(s); first 20:`);
    for (const failure of failures.slice(0, 20)) log.error(`  ${failure}`);
  }
}
