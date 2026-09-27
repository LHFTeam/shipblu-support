import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, messages } from '@/db/schema';
import { deleteComment, MetaApiError, setCommentHidden } from '@/lib/meta/client';
import { metaConnection } from '@/lib/meta/connection';
import { explainMetaModerationError } from '@/lib/meta/errors';
import {
  eventTypeFor,
  failed,
  moderatableComment,
  type ModerationAction,
  readCommentModeration,
  settled,
} from '@/lib/meta/moderation';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { subjectGone } from './subject-gone';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

const log = logger('moderate_meta_comment');

/**
 * Hides, unhides or deletes a public comment at Meta.
 *
 * A job rather than a call inside the server action, for the reasons everything
 * else that talks to Graph is: it is external, it is rate-limited, and a blip
 * should delay the moderation rather than lose it. The agent is not left
 * guessing in the meantime — the action marks the comment pending and the
 * timeline says so, and this handler's `UPDATE` on `messages` fires the same
 * `notify_change` trigger a customer's reply does, so the resolved state reaches
 * the open ticket over the existing stream rather than on the next full load.
 *
 * **Enqueued without a dedupe key.** Hide and unhide are each other's opposite
 * and an agent may reasonably do both twice in a minute; `jobs_dedupe_idx` is a
 * plain unique index over the whole table, so a key on the comment would be
 * spent by the first hide and every later request would silently do nothing.
 * The guard is `moderationRefusal` at the point of asking, and this handler
 * being safe to run twice.
 */

export async function moderateMetaComment(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'moderate_meta_comment');
  const { messageId } = payload;
  const action: ModerationAction = payload.action;
  const agentId = payload.agentId ?? null;

  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      meta: messages.meta,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) throw subjectGone('moderate_meta_comment', `message ${messageId}`);

  const comment = moderatableComment(row.meta);
  if (!comment) throw new Error(`message ${messageId} is not a Meta comment`);

  const before = readCommentModeration(row.meta);

  // The route the moderation call will take, for the log and the explanation.
  // Not read off the comment's own `meta`: the connection recorded there is
  // whichever delivery reached ingest first, while the one that matters is
  // whichever holds a usable credential now — and both address the same comment
  // id with the same paths.
  const connection = metaConnection(comment.platform);

  // A retry that arrives after the work landed must not ask Graph again: an
  // unhide-then-retry would undo a hide the agent still wants, and a repeated
  // delete is refused with an error that reads like the ticket is broken.
  if (before.pending === null) {
    log.info(`${messageId} is already settled, skipping`);
    return;
  }

  try {
    if (action === 'delete') {
      await deleteComment({ platform: comment.platform, commentId: comment.commentId });
    } else {
      await setCommentHidden({
        platform: comment.platform,
        commentId: comment.commentId,
        hidden: action === 'hide',
      });
    }
  } catch (error) {
    const message = errorMessage(error);

    // The same treatment a refused send gets: Graph's own sentence, plus what we
    // know about the request it was refusing. "Unsupported post request" alone
    // reads as "that comment is gone" whether or not it is.
    const explained =
      error instanceof MetaApiError
        ? explainMetaModerationError(error, {
            platform: comment.platform,
            connection,
            action: action as ModerationAction,
          })
        : message;

    await writeModeration(row.id, row.meta, failed(before, explained));

    // Same rule as a refused send: a permanent refusal is not worth four more
    // attempts, and the agent finds out from the comment's own bubble.
    if (error instanceof MetaApiError && !error.isTransient) {
      log.error(`${messageId} ${action} failed permanently: ${message}`);
      return;
    }

    throw error;
  }

  const now = new Date();
  await writeModeration(row.id, row.meta, settled(before, action as ModerationAction, now));

  // Written here rather than when the agent asked, so the timeline records what
  // Meta did and not what somebody wanted.
  await db.insert(conversationEvents).values({
    conversationId: row.conversationId,
    type: eventTypeFor(action as ModerationAction),
    actorAgentId: agentId,
    // A moderation nobody can be named for is one this job did on a retry after
    // the agent's row was removed; the label keeps the event attributable.
    actorLabel: agentId ? null : 'moderate_meta_comment',
    data: { commentId: comment.commentId, platform: comment.platform, connection },
  });

  log.info(
    `${action} ${comment.platform} comment ${comment.commentId} ` +
      `on message ${messageId} via ${connection}`,
  );
}

/**
 * Read-modify-write of the one key inside `meta`.
 *
 * The whole object is rewritten from the copy read at the top of the handler
 * rather than merged in SQL with `||`. Nothing else writes a comment message's
 * `meta` after ingest — this handler is its only later writer — so there is no
 * concurrent key to lose, and a plain object keeps the update out of the class
 * of raw fragments no local check can validate.
 */
async function writeModeration(
  messageId: string,
  meta: unknown,
  moderation: Record<string, unknown>,
): Promise<void> {
  const base = (meta ?? {}) as Record<string, unknown>;

  await db
    .update(messages)
    .set({ meta: { ...base, moderation } })
    .where(eq(messages.id, messageId));
}
