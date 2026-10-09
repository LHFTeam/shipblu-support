import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import {
  applyWhatsAppStatus,
  ingestWhatsAppEcho,
  ingestWhatsAppMessage,
} from '@/lib/tickets/ingest-whatsapp';
import {
  applyWhatsAppContactSync,
  attachHistoryMedia,
  ingestWhatsAppHistoryChunk,
} from '@/lib/tickets/ingest-whatsapp-history';
import {
  applyWhatsAppAccountUpdate,
  type CoexistenceChannel,
  findCoexistenceChannel,
  recordContactSync,
} from '@/lib/whatsapp/coexistence-state';
import { parseWebhook } from '@/lib/whatsapp/parse';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

const log = logger('whatsapp');

/**
 * Turns a stored Meta webhook payload into conversations and delivery updates.
 *
 * A single batch can carry unrelated messages from different customers, so one
 * bad message must not discard the rest: each is processed independently and
 * failures are collected. The job only fails — and so only retries — if
 * *everything* in the batch failed, which is the signal for a real outage
 * rather than one malformed message.
 *
 * A number connected through coexistence adds four kinds: chunks of its copied
 * chat history, the files behind that history's placeholders, entries from the
 * phone's address book, and `account_update` events about the connection. The
 * first three are stamped with when the delivery reached us, not with anything
 * in the payload; the history's own messages keep their own instants.
 *
 * **History is the exception to "only when everything failed".** A chunk is
 * many customers' threads, and one that throws part-way leaves the threads
 * after it unimported and its progress unrecorded — so the copy may never
 * reach 100%, and nothing would ever say why, because the sibling that
 * succeeded marked the delivery processed. Its failure is usually the
 * transient kind (the database, not the payload), and every part of a
 * delivery is safe to run again: messages, echoes and history by wamid,
 * statuses forward only, account updates by their instant. So a failed
 * history item retries the whole delivery, and one that keeps failing goes
 * `dead` where it can be seen. What a retry does count twice — the chunk and
 * contact counters of the parts that had worked — is display only, and is the
 * price of not splitting a delivery into jobs.
 */
export async function processWhatsAppWebhook(event: {
  id: string;
  payload: unknown;
  receivedAt: Date;
}): Promise<void> {
  const parsed = parseWebhook(event.payload);

  if (parsed.errors.length) {
    log.warn(`account errors on ${event.id}: ${parsed.errors.join('; ')}`);
  }

  const failures: string[] = [];
  /** A history chunk or its media failed: the delivery retries whatever else worked. */
  let historyFailed = false;
  let ingested = 0;
  let echoed = 0;
  let statusUpdates = 0;
  let historyMessages = 0;
  let contactsApplied = 0;
  let accountUpdates = 0;
  /** Coexistence parts that were not about a number connected that way, or had nothing to attach to. */
  let skipped = 0;

  for (const message of parsed.messages) {
    try {
      const result = await ingestWhatsAppMessage(message);
      ingested += 1;
      log.info(
        `${message.wamid} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`${message.wamid}: ${errorMessage(error)}`);
    }
  }

  // Messages the bot sent, mirrored so the transcript reads as a conversation
  // rather than as one side of one. Echoes for the support number are our own
  // replies coming back and are ignored by the ingest.
  for (const echo of parsed.echoes) {
    try {
      const result = await ingestWhatsAppEcho(echo);
      if (result.ignored) continue;
      echoed += 1;
      log.info(
        `echo ${echo.wamid} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`echo ${echo.wamid}: ${errorMessage(error)}`);
    }
  }

  for (const status of parsed.statuses) {
    try {
      if (await applyWhatsAppStatus(status)) statusUpdates += 1;
    } catch (error) {
      failures.push(`status ${status.wamid}: ${errorMessage(error)}`);
    }
  }

  for (const chunk of parsed.history) {
    try {
      const result = await ingestWhatsAppHistoryChunk(chunk, event.receivedAt);
      if (result.skipped === 'not_coexistence') {
        skipped += 1;
        continue;
      }
      if (result.skipped === 'declined') {
        log.warn(`history declined on the phone for ${chunk.phoneNumberId}`);
        continue;
      }
      historyMessages += result.inserted;
      log.info(
        `history ${chunk.phoneNumberId} phase ${chunk.phase ?? '?'} ` +
          `${chunk.progress ?? '?'}%: ${result.threads} thread(s), ${result.created} new, ` +
          `${result.inserted} message(s), ${result.duplicates} already stored`,
      );
    } catch (error) {
      historyFailed = true;
      failures.push(`history ${chunk.phoneNumberId} phase ${chunk.phase}: ${errorMessage(error)}`);
    }
  }

  for (const media of parsed.historyMedia) {
    try {
      if (!(await attachHistoryMedia(media))) skipped += 1;
    } catch (error) {
      historyFailed = true;
      failures.push(`history media ${media.wamid}: ${errorMessage(error)}`);
    }
  }

  // The address book arrives as thousands of entries, many to a delivery and
  // possibly for more than one number: the channel is found once per number,
  // and each channel's counter moves once, by what was applied to it.
  const contactChannels = new Map<string | null, CoexistenceChannel | null>();
  const appliedByChannel = new Map<string, number>();
  for (const sync of parsed.contactSyncs) {
    try {
      let channel = contactChannels.get(sync.phoneNumberId);
      if (channel === undefined) {
        channel = await findCoexistenceChannel(sync.phoneNumberId);
        contactChannels.set(sync.phoneNumberId, channel);
      }
      const result = await applyWhatsAppContactSync(sync, channel);
      if (result === 'applied' && channel) {
        contactsApplied += 1;
        appliedByChannel.set(channel.id, (appliedByChannel.get(channel.id) ?? 0) + 1);
      } else if (result !== 'removed') skipped += 1;
    } catch (error) {
      failures.push(`contact ${sync.action}: ${errorMessage(error)}`);
    }
  }
  for (const [channelId, count] of appliedByChannel) {
    try {
      await recordContactSync(channelId, event.receivedAt, count);
    } catch (error) {
      failures.push(`contact count on ${channelId}: ${errorMessage(error)}`);
    }
  }

  for (const update of parsed.accountUpdates) {
    try {
      const touched = await applyWhatsAppAccountUpdate(update);
      accountUpdates += touched;
      if (touched > 0) {
        // In the message rather than as fields: `warn` takes the caught value
        // as its second argument and would print an object there raw, where
        // a log search for `reason=…` finds the ` key=value` tail.
        log.warn(
          `account_update ${update.event} for WABA ${update.wabaId}: ${touched} channel(s) ` +
            `reason=${update.reason ?? 'none'} initiatedBy=${update.initiatedBy ?? 'unknown'}`,
        );
      }
    } catch (error) {
      failures.push(`account_update ${update.event}: ${errorMessage(error)}`);
    }
  }

  const attempted =
    parsed.messages.length +
    parsed.echoes.length +
    parsed.statuses.length +
    parsed.history.length +
    parsed.historyMedia.length +
    parsed.contactSyncs.length +
    parsed.accountUpdates.length;

  if (failures.length > 0 && failures.length === attempted) {
    throw new Error(`every item in the batch failed: ${failures.join(' | ')}`);
  }

  if (historyFailed) {
    throw new Error(`a history item failed, so the delivery is retried: ${failures.join(' | ')}`);
  }

  if (failures.length > 0) {
    // Partial failure: recorded on the event so it is visible when inspecting
    // the row, but not retried — a retry would re-run the parts that worked.
    // History is the exception above because re-running it was reasoned
    // through; widening that to every item is a change of its own.
    log.error(`partial failure on ${event.id}: ${failures.join(' | ')}`);
    await db
      .update(webhookEvents)
      .set({ error: failures.join(' | ').slice(0, 2000) })
      .where(eq(webhookEvents.id, event.id));
  }

  const coexistence =
    parsed.history.length +
      parsed.historyMedia.length +
      parsed.contactSyncs.length +
      parsed.accountUpdates.length >
    0
      ? `, ${historyMessages} history message(s), ${contactsApplied} contact(s), ` +
        `${accountUpdates} account update(s), ${skipped} skipped`
      : '';

  log.info(
    `${event.id}: ${ingested} message(s), ${echoed} echo(es), ` +
      `${statusUpdates} status update(s)` +
      coexistence +
      (failures.length ? `, ${failures.length} failed` : ''),
  );
}
