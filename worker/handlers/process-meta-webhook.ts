import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { parseMetaWebhook } from '@/lib/meta/parse';
import {
  applyMetaHandover,
  applyMetaReceipt,
  ingestMetaComment,
  ingestMetaMessage,
} from '@/lib/tickets/ingest-meta';

/**
 * Turns a stored Facebook or Instagram payload into conversations.
 *
 * One batch can carry unrelated events from different customers, so each is
 * processed independently and failures are collected. The job only fails — and
 * so only retries — when *everything* in the batch failed, which distinguishes
 * a real outage from one malformed comment.
 */
export async function processMetaWebhook(event: { id: string; payload: unknown }): Promise<void> {
  const parsed = parseMetaWebhook(event.payload);

  const failures: string[] = [];
  let messages = 0;
  let comments = 0;
  let receipts = 0;
  let handovers = 0;

  for (const message of parsed.messages) {
    try {
      const result = await ingestMetaMessage(message);
      messages += 1;
      console.log(
        `[meta] ${message.platform} dm ${message.mid} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`${message.mid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const comment of parsed.comments) {
    try {
      const result = await ingestMetaComment(comment);
      comments += 1;
      console.log(
        `[meta] ${comment.platform} comment ${comment.commentId} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(
        `comment ${comment.commentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const receipt of parsed.receipts) {
    try {
      receipts += await applyMetaReceipt(receipt);
    } catch (error) {
      failures.push(`receipt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const handover of parsed.handovers) {
    try {
      if (await applyMetaHandover(handover)) handovers += 1;
    } catch (error) {
      failures.push(
        `handover ${handover.kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const attempted =
    parsed.messages.length +
    parsed.comments.length +
    parsed.receipts.length +
    parsed.handovers.length;

  if (failures.length > 0 && failures.length === attempted) {
    throw new Error(`every item in the batch failed: ${failures.join(' | ')}`);
  }

  if (failures.length > 0) {
    console.error(`[meta] partial failure on ${event.id}: ${failures.join(' | ')}`);
    await db
      .update(webhookEvents)
      .set({ error: failures.join(' | ').slice(0, 2000) })
      .where(eq(webhookEvents.id, event.id));
  }

  console.log(
    `[meta] ${event.id}: ${messages} message(s), ${comments} comment(s), ` +
      `${receipts} receipt(s), ${handovers} handover(s), ${parsed.echoes} echo(es) ignored`,
  );
}
