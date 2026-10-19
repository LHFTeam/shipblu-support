import { recordMetaFeedback } from '@/lib/csat/meta-feedback';
import type { MetaConnection } from '@/lib/meta/connection';
import { parseMetaWebhook } from '@/lib/meta/parse';
import {
  applyMetaInteraction,
  applyMetaReceipt,
  ingestMetaComment,
  ingestMetaMessage,
} from '@/lib/tickets/ingest-meta';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

const log = logger('meta');

/**
 * Turns a stored Facebook or Instagram payload into conversations.
 *
 * One batch can carry unrelated events from different customers, so each is
 * processed independently and failures are collected: one item that throws
 * does not stop the rest. **Any failure then fails the job**, so the queue
 * runs the whole delivery again, and a delivery that keeps failing goes
 * `dead` where it can be seen.
 *
 * It used to fail only when *every* item had failed, to tell an outage from
 * one malformed comment. That dropped the item that failed beside one that
 * worked — a message, or a survey answer, lost to a dropped connection, with
 * nothing to retry it and Meta never redelivering. The rerun is safe because
 * every item type does nothing the second time:
 *
 * - a message and a comment are found by their mid or comment id, before
 *   anything is written (`ingestMetaMessage`, `ingestMetaComment`);
 * - an interaction by its instant on the ticket (`applyMetaInteraction`);
 * - a survey answer by `recordAnswer`'s first-answer-wins, and only a first
 *   answer is thanked (`recordMetaFeedback`);
 * - a receipt moves a message forward only (`applyMetaReceipt`).
 *
 * Instagram, delivered on both of its connections, already ran its items
 * twice; on Facebook a second run is new, which is why each item type's dedupe
 * is listed above. What a retry adds is order: the item that failed
 * now lands after siblings that are newer than it, which is why the ingest
 * moves a ticket's "last" columns and its reply clock forward only. A new
 * item type has to meet both.
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
  let answers = 0;
  // Interactions that found no live ticket, or had already been recorded, and
  // survey answers that recorded nothing — a second copy, an unknown survey,
  // somebody other than the requester. For the log line only; on a retry it
  // includes what an earlier attempt recorded.
  let skipped = 0;

  for (const message of parsed.messages) {
    try {
      const result = await ingestMetaMessage(message);
      messages += 1;
      log.info(
        `${message.platform} dm ${message.mid} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`${message.mid}: ${errorMessage(error)}`);
    }
  }

  for (const comment of parsed.comments) {
    try {
      const result = await ingestMetaComment(comment);
      comments += 1;
      log.info(
        `${comment.platform} comment ${comment.commentId} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`comment ${comment.commentId}: ${errorMessage(error)}`);
    }
  }

  for (const interaction of parsed.interactions) {
    try {
      const applied = await applyMetaInteraction(interaction);
      if (applied) interactions += 1;
      else skipped += 1;
      log.info(
        `${interaction.platform} ${interaction.kind} from ${interaction.from} ` +
          `(${interaction.summary}) → ${applied ? 'recorded' : 'no live ticket, or already recorded'}`,
      );
    } catch (error) {
      failures.push(`${interaction.kind}: ${errorMessage(error)}`);
    }
  }

  for (const feedback of parsed.feedbacks) {
    try {
      const outcome = await recordMetaFeedback(feedback);
      if (outcome === 'recorded' || outcome === 'comment_added') answers += 1;
      else skipped += 1;
      log.info(
        `${feedback.platform} survey answer (${feedback.source}, ${feedback.rating}) ` +
          `from ${feedback.from} → ${outcome}`,
      );
    } catch (error) {
      failures.push(`survey answer for ${feedback.surveyId}: ${errorMessage(error)}`);
    }
  }

  for (const receipt of parsed.receipts) {
    try {
      receipts += await applyMetaReceipt(receipt);
    } catch (error) {
      failures.push(`receipt: ${errorMessage(error)}`);
    }
  }

  log.info(
    `${event.id} via ${event.connection ?? 'an unrecorded connection'}: ` +
      `${messages} message(s), ${comments} comment(s), ${receipts} receipt(s), ` +
      `${interactions} interaction(s), ${answers} survey answer(s) (${skipped} skipped), ` +
      `${parsed.echoes} echo(es) ignored, ` +
      `${parsed.emptyCards} empty card(s) ignored` +
      (failures.length ? `, ${failures.length} failed` : ''),
  );

  // Written on the row by `processWebhook` as it rethrows, and gone from it
  // once an attempt succeeds. Cut short, as the partial-failure note this
  // replaces was: a database outage fails every item of a large batch, each
  // error carries its statement's parameters — customer text — and a dead
  // job's `last_error` is kept for good.
  if (failures.length > 0) {
    const message =
      `${failures.length} item(s) in the batch failed, so the delivery is retried: ` +
      failures.join(' | ');
    throw new Error(message.slice(0, 2000));
  }
}

/** The stored connection, or null for anything that is not one we know. */
function readConnection(value: string | null): MetaConnection | null {
  return value === 'facebook_page' || value === 'instagram_login' ? value : null;
}
