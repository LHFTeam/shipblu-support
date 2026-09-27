import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logChannelTable, scanMessagesInKeysetOrder } from '@/lib/queue/backfill';
import { parseCoordinates, readSharedLocation } from '@/lib/tickets/shared-location';
import { errorMessage } from '@/lib/errors';

/**
 * Recovers the pins already sitting in the archive.
 *
 * The live path only ever sees new messages, so without this every location a
 * customer shared before the feature landed stays as prose — the coordinates are
 * in `body_text` as characters, and the console has nothing structured to build
 * a map link from.
 *
 * It reads them back out of `raw_body`, which holds the original WhatsApp
 * payload for every message ingested on this channel. That is the source rather
 * than a second guess at it: parsing the coordinates back out of the generated
 * `[location (…)]` text would be re-deriving them from our own formatting, and
 * would inherit any rounding that formatting ever applies.
 *
 * Idempotent by construction. A row that already has a readable location is
 * skipped, and the write merges into `meta` rather than replacing it, so a second
 * run changes nothing and no other key — `whatsappType`, `media`, the bot's
 * `echo` flag — is disturbed.
 *
 * It never deletes. A pin that no longer validates stays as it is; removing one
 * would be a separate, deliberate decision.
 */

const BATCH = 500;

type ChannelTally = {
  candidates: number;
  alreadyDone: number;
  recovered: number;
  unreadable: number;
};

function emptyTally(): ChannelTally {
  return { candidates: 0, alreadyDone: 0, recovered: 0, unreadable: 0 };
}

export async function backfillMessageLocations(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'backfill_message_locations');
  const dryRun = payload.dryRun === true;

  const bounds: SQL[] = [];
  if (payload.since) bounds.push(gte(messages.createdAt, new Date(payload.since)));
  if (payload.until) bounds.push(lte(messages.createdAt, new Date(payload.until)));

  // Only rows that could possibly carry one. The `like` is a cheap prefilter
  // that keeps this from parsing nine thousand JSON blobs to find eight hundred
  // — the parse below is what actually decides.
  bounds.push(sql`${messages.rawBody} is not null`);
  bounds.push(sql`${messages.rawBody} like '%"location"%'`);

  const tallies = new Map<string, ChannelTally>();
  const failures: string[] = [];

  const scanned = await scanMessagesInKeysetOrder(
    { batchSize: BATCH, limit: payload.limit },
    (after, size) =>
      db
        .select({
          id: messages.id,
          meta: messages.meta,
          rawBody: messages.rawBody,
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
      tally.candidates += 1;

      // Already carries one: nothing to do, and this is what makes a re-run free.
      if (readSharedLocation(message.meta)) {
        tally.alreadyDone += 1;
        return;
      }

      const location = locationFromRawBody(message.rawBody);
      if (!location) {
        // Reached here because `raw_body` mentions "location" but no usable pin
        // came out — a contact card with a location field, a pin with a
        // malformed coordinate. Counted rather than logged per row: at this
        // volume a line each would bury the figures that matter.
        tally.unreadable += 1;
        return;
      }

      if (dryRun) {
        tally.recovered += 1;
        return;
      }

      try {
        await db
          .update(messages)
          // Merged, not assigned. `meta` holds whatsappType, profileName,
          // phoneNumberId and the media block; setting the column outright here
          // would drop all of them, and a jsonb concat in one statement also
          // avoids the read-modify-write race a fetch-and-set would open.
          .set({ meta: sql`${messages.meta} || ${JSON.stringify({ location })}::jsonb` })
          .where(eq(messages.id, message.id));

        tally.recovered += 1;
      } catch (error) {
        // One bad row must not end the run. The rest of the archive is still
        // worth repairing, and the job fails at the end with the list.
        failures.push(`${message.id}: ${errorMessage(error)}`);
      }
    },
  );

  report(scanned, tallies, failures, dryRun);

  if (failures.length > 0) {
    throw new Error(`backfill_message_locations: ${failures.length} message(s) failed`);
  }
}

/**
 * The pin inside a stored WhatsApp payload.
 *
 * Tolerates anything: `raw_body` is a string column written by
 * `JSON.stringify` over a payload Meta shaped, and a row old enough or odd
 * enough to be unparseable is a skip, never a throw.
 */
export function locationFromRawBody(rawBody: string | null): {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
} | null {
  if (!rawBody) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const location = (parsed as { location?: unknown }).location;
  if (typeof location !== 'object' || location === null) return null;

  const fields = location as Record<string, unknown>;
  const coordinates = parseCoordinates(fields.latitude, fields.longitude);
  if (!coordinates) return null;

  return {
    ...coordinates,
    name: trimmedOrNull(fields.name),
    address: trimmedOrNull(fields.address),
  };
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function report(
  scanned: number,
  tallies: Map<string, ChannelTally>,
  failures: string[],
  dryRun: boolean,
): void {
  const tag = '[backfill_message_locations]';
  console.log(`${tag} scanned ${scanned} candidate messages (dry_run=${dryRun})`);

  logChannelTable(tag, tallies, [
    { heading: 'candidates', width: 11, value: (tally) => tally.candidates },
    { heading: 'already', width: 9, value: (tally) => tally.alreadyDone },
    { heading: 'recovered', width: 10, value: (tally) => tally.recovered },
    { heading: 'unreadable', width: 11, value: (tally) => tally.unreadable },
  ]);

  // Broken down per channel above, and called out here, for the reason in trap
  // 14: "recovered 806" reads as a clean run even when every pin on one channel
  // was skipped. A channel that is mostly unreadable means the payload on it is
  // not shaped the way this assumes.
  for (const [channel, tally] of [...tallies.entries()].sort()) {
    const attempted = tally.candidates - tally.alreadyDone;
    if (attempted > 0 && tally.unreadable > attempted / 2) {
      console.warn(
        `${tag} ${channel}: ${tally.unreadable} of ${attempted} candidates had no readable pin`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`${tag} ${failures.length} failed: ${failures.slice(0, 20).join('; ')}`);
  }
}
