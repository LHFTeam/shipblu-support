import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { requesterCommentId } from '@/lib/meta/comments';
import { readCommentModeration } from '@/lib/meta/moderation';

/**
 * Which comment an agent's reply on a comment ticket answers: the requester's
 * own, never a passer-by's (`requesterCommentId`).
 *
 * Read here, by the reply action and by `send_meta`, rather than taken from
 * the form. The composer posts the id of the message the agent picked, and
 * that is only a claim: the action re-reads it against this ticket and its
 * requester before the reply is written, and stores the comment it names on
 * the reply's `meta.commentId`, so the job sends to what was checked. The
 * job's own read is for a reply stored before the action named one.
 */

/**
 * Said by the action and by `send_meta` when a private reply has nothing to
 * answer, so the agent reads one sentence whichever of them refused it.
 */
export const NO_REQUESTER_COMMENT =
  'There is no comment from this ticket’s customer to answer privately. A private reply ' +
  'goes to whoever wrote the comment it answers, and none of the comments here is theirs.';

export const COMMENT_DELETED =
  'That comment was deleted from the post, and Meta refuses a private reply to a comment ' +
  'that is gone. Pick another of the customer’s.';

export const COMMENT_ANSWERED =
  'That comment already has a private reply, and Meta allows one per comment, ever. ' +
  'Pick another of the customer’s.';

export type RequesterComment = {
  commentId: string;
  /** Deleted from the post through the console (`moderate_meta_comment`). */
  deleted: boolean;
};

/**
 * The requester's newest comment on the ticket, preferring one still on the
 * post, or null when they have none on it.
 *
 * Still on the post first because a reply named after a deleted comment is
 * refused by Graph: a public one on Facebook is posted under the comment it
 * names, and a private one is addressed to it. Deleted comments still count
 * when nothing else does, so "none of theirs" stays the refusal for a ticket
 * with no comment of theirs at all, and a deleted one is refused for what it
 * is (`privateReplyRefusal`).
 */
export async function newestRequesterComment(
  conversationId: string,
  requesterContactId: string,
): Promise<RequesterComment | null> {
  return requesterComment(conversationId, requesterContactId, null);
}

/**
 * The comment a message the agent picked is, or null when it is not one of the
 * requester's comments on this ticket — another ticket's message, a
 * passer-by's comment, our own reply, or nothing at all.
 */
export async function requesterCommentById(
  conversationId: string,
  requesterContactId: string,
  messageId: string,
): Promise<RequesterComment | null> {
  return requesterComment(conversationId, requesterContactId, messageId);
}

/**
 * Why a private reply may not answer this comment, or null when it may — the
 * two refusals Meta would otherwise make after the reply is on the timeline,
 * marked failed. The composer marks the same two and never chooses them
 * (`lib/tickets/private-reply-options.ts`); this is the half a stale tab, a
 * second agent or a hand-made request cannot get round.
 *
 * A private reply not known to have failed spends the comment, pending
 * included, so a resend straight after a send is caught; a failed one spends
 * nothing, since Graph refused it.
 */
export async function privateReplyRefusal(
  conversationId: string,
  comment: RequesterComment,
): Promise<string | null> {
  if (comment.deleted) return COMMENT_DELETED;

  const answered = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        sql`${messages.meta}->>'sendKind' = 'private_reply'`,
        sql`${messages.meta}->>'commentId' = ${comment.commentId}`,
        ne(messages.deliveryStatus, 'failed'),
      ),
    )
    .limit(1);

  return answered.length > 0 ? COMMENT_ANSWERED : null;
}

async function requesterComment(
  conversationId: string,
  requesterContactId: string,
  messageId: string | null,
): Promise<RequesterComment | null> {
  const rows = await db
    .select({
      direction: messages.direction,
      authorContactId: messages.authorContactId,
      meta: messages.meta,
      channelMessageId: messages.channelMessageId,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        eq(messages.authorContactId, requesterContactId),
        // In the query as well as in `requesterCommentId`, so a requester's
        // later message that is not a comment cannot hide their newest
        // comment behind it — a row the predicate below would then refuse.
        sql`${messages.meta}->>'metaKind' = 'comment'`,
        messageId ? eq(messages.id, messageId) : undefined,
      ),
    )
    // A comment still on the post first (false sorts before true), then the
    // comment's own instant, which ingest writes as `created_at`, and the id
    // after it — the order the ticket page lists them in.
    .orderBy(
      sql`(${messages.meta}->'moderation'->>'deleted') is not distinct from 'true'`,
      desc(messages.createdAt),
      desc(messages.id),
    )
    .limit(1);

  const row = rows[0];
  const commentId = row ? requesterCommentId(row, requesterContactId) : null;
  if (!row || !commentId) return null;
  return { commentId, deleted: readCommentModeration(row.meta).deleted };
}
