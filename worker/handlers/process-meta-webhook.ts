import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import type { MetaConnection } from '@/lib/meta/connection';
import { parseMetaWebhook } from '@/lib/meta/parse';
import {
  applyMetaInteraction,
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
 *
 * The connection travels on the row rather than being worked out here: the two
 * Instagram connections post identical bodies and are separated only by which
 * app secret verified the signature, which is known at the endpoint and nowhere
 * else. Null on anything stored before the column existed.
 */
export async function processMetaWebhook(event: {
  id: string;
  payload: unknown;
  connection: string | null;
}): Promise<void> {
  const parsed = parseMetaWebhook(event.payload, readConnection(event.connection));

  const failures: string[] = [];
  let messages = 0;
  let comments = 0;
  let receipts = 0;
  let interactions = 0;
  // Interactions that found no live ticket, or had already been recorded. They
  // did nothing, so they must not count toward `attempted` below.
  let skipped = 0;

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

  for (const interaction of parsed.interactions) {
    try {
      const applied = await applyMetaInteraction(interaction);
      if (applied) interactions += 1;
      else skipped += 1;
      console.log(
        `[meta] ${interaction.platform} ${interaction.kind} from ${interaction.from} ` +
          `(${interaction.summary}) → ${applied ? 'recorded' : 'no live ticket'}`,
      );
    } catch (error) {
      failures.push(
        `${interaction.kind}: ${error instanceof Error ? error.message : String(error)}`,
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

  // What could meaningfully have failed. An interaction that no-ops — nobody to
  // attach it to, or a copy already recorded — is not a success, and counting it
  // as one widens this denominator: a batch of one failed customer message and
  // one such interaction would no longer be "everything failed", so the job
  // would report success, the webhook would be stamped processed, and the
  // customer's message would be lost with no retry.
  const attempted =
    parsed.messages.length +
    parsed.comments.length +
    parsed.receipts.length +
    parsed.interactions.length -
    skipped;

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
    `[meta] ${event.id} via ${event.connection ?? 'an unrecorded connection'}: ` +
      `${messages} message(s), ${comments} comment(s), ${receipts} receipt(s), ` +
      `${interactions} interaction(s) (${skipped} skipped), ${parsed.echoes} echo(es) ignored`,
  );
}

/** The stored connection, or null for anything that is not one we know. */
function readConnection(value: string | null): MetaConnection | null {
  return value === 'facebook_page' || value === 'instagram_login' ? value : null;
}
