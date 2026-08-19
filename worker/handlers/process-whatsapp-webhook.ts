import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import {
  applyWhatsAppStatus,
  ingestWhatsAppEcho,
  ingestWhatsAppMessage,
} from '@/lib/tickets/ingest-whatsapp';
import { parseWebhook } from '@/lib/whatsapp/parse';

/**
 * Turns a stored Meta webhook payload into conversations and delivery updates.
 *
 * A single batch can carry unrelated messages from different customers, so one
 * bad message must not discard the rest: each is processed independently and
 * failures are collected. The job only fails — and so only retries — if
 * *everything* in the batch failed, which is the signal for a real outage
 * rather than one malformed message.
 */
export async function processWhatsAppWebhook(event: {
  id: string;
  payload: unknown;
}): Promise<void> {
  const parsed = parseWebhook(event.payload);

  if (parsed.errors.length) {
    console.warn(`[whatsapp] account errors on ${event.id}: ${parsed.errors.join('; ')}`);
  }

  const failures: string[] = [];
  let ingested = 0;
  let echoed = 0;
  let statusUpdates = 0;

  for (const message of parsed.messages) {
    try {
      const result = await ingestWhatsAppMessage(message);
      ingested += 1;
      console.log(
        `[whatsapp] ${message.wamid} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`${message.wamid}: ${error instanceof Error ? error.message : String(error)}`);
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
      console.log(
        `[whatsapp] echo ${echo.wamid} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(
        `echo ${echo.wamid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const status of parsed.statuses) {
    try {
      if (await applyWhatsAppStatus(status)) statusUpdates += 1;
    } catch (error) {
      failures.push(
        `status ${status.wamid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const attempted = parsed.messages.length + parsed.echoes.length + parsed.statuses.length;

  if (failures.length > 0 && failures.length === attempted) {
    throw new Error(`every item in the batch failed: ${failures.join(' | ')}`);
  }

  if (failures.length > 0) {
    // Partial failure: recorded on the event so it is visible when inspecting
    // the row, but not retried — a retry would re-run the parts that worked.
    console.error(`[whatsapp] partial failure on ${event.id}: ${failures.join(' | ')}`);
    await db
      .update(webhookEvents)
      .set({ error: failures.join(' | ').slice(0, 2000) })
      .where(eq(webhookEvents.id, event.id));
  }

  console.log(
    `[whatsapp] ${event.id}: ${ingested} message(s), ${echoed} echo(es), ` +
      `${statusUpdates} status update(s)` +
      (failures.length ? `, ${failures.length} failed` : ''),
  );
}
