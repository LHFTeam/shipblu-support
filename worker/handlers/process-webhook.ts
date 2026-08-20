import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { emailProvider } from '@/lib/email/providers';
import type { ClaimedJob } from '@/lib/queue';
import { ingestInboundEmail } from '@/lib/tickets/ingest';
import { processMetaWebhook } from './process-meta-webhook';
import { processWhatsAppWebhook } from './process-whatsapp-webhook';

/**
 * Processes a stored webhook payload into a ticket.
 *
 * Marking `processed_at` is what makes replay safe: a payload is only ever
 * turned into a ticket once, and ingest itself is independently idempotent on
 * the email's Message-ID, so even a double-run cannot duplicate a message.
 */
export async function processWebhook(job: ClaimedJob): Promise<void> {
  const webhookEventId = job.payload.webhookEventId;
  if (typeof webhookEventId !== 'string') {
    throw new Error('process_webhook requires a webhookEventId');
  }

  const rows = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, webhookEventId))
    .limit(1);

  const event = rows[0];
  if (!event) throw new Error(`webhook_event ${webhookEventId} not found`);

  if (event.processedAt) {
    console.log(`[process_webhook] ${webhookEventId} already processed, skipping`);
    return;
  }

  // Refuse to act on anything that failed verification, even if a job for it
  // was somehow enqueued.
  if (!event.signatureVerified) {
    throw new Error(`webhook_event ${webhookEventId} failed signature verification`);
  }

  await db
    .update(webhookEvents)
    .set({ attempts: sql`${webhookEvents.attempts} + 1` })
    .where(eq(webhookEvents.id, webhookEventId));

  try {
    // One entry point for every channel, so webhook storage, replay and
    // idempotency behave identically no matter who sent the payload.
    if (event.channel === 'whatsapp') {
      await processWhatsAppWebhook({ id: event.id, payload: event.payload });
      await db
        .update(webhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(webhookEvents.id, webhookEventId));
      return;
    }

    if (event.channel === 'facebook' || event.channel === 'instagram') {
      await processMetaWebhook({ id: event.id, payload: event.payload });
      await db
        .update(webhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(webhookEvents.id, webhookEventId));
      return;
    }

    if (event.channel !== 'email') {
      throw new Error(`unsupported webhook channel "${event.channel}"`);
    }

    const parsed = await emailProvider().parseInbound(event.payload);
    const result = await ingestInboundEmail(parsed);

    if (result === null) {
      // Deliberately dropped (self-addressed loop). Mark processed so it is not
      // retried, and record why.
      await db
        .update(webhookEvents)
        .set({ processedAt: new Date(), error: 'dropped: self-addressed' })
        .where(eq(webhookEvents.id, webhookEventId));
      return;
    }

    await db
      .update(webhookEvents)
      .set({ processedAt: new Date(), error: null })
      .where(eq(webhookEvents.id, webhookEventId));

    const where =
      result.sideConversationNumber !== undefined
        ? `side conversation #${result.sideConversationNumber} on ticket #${result.conversationNumber}`
        : `ticket #${result.conversationNumber}`;

    console.log(
      `[process_webhook] ${webhookEventId} → ${where} ` +
        `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
    );
  } catch (error) {
    // Recorded on the row as well as thrown, so a failure is visible when
    // inspecting the event rather than only in the job's last_error.
    await db
      .update(webhookEvents)
      .set({ error: error instanceof Error ? error.message : String(error) })
      .where(eq(webhookEvents.id, webhookEventId));
    throw error;
  }
}
