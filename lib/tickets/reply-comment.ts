import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { requesterCommentId } from '@/lib/meta/comments';

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

/** The requester's newest comment on the ticket, or null when they have none on it. */
export async function newestRequesterComment(
  conversationId: string,
  requesterContactId: string,
): Promise<string | null> {
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
): Promise<string | null> {
  return requesterComment(conversationId, requesterContactId, messageId);
}

async function requesterComment(
  conversationId: string,
  requesterContactId: string,
  messageId: string | null,
): Promise<string | null> {
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
        // A comment deleted from the post is still the customer's, and is
        // left in: Graph's refusal says what happened to it, where leaving it
        // out would refuse here for want of a comment the agent can see.
        sql`${messages.meta}->>'metaKind' = 'comment'`,
        messageId ? eq(messages.id, messageId) : undefined,
      ),
    )
    // The comment's own instant, which ingest writes as `created_at`, and the
    // id after it — the order the ticket page lists them in.
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);

  const row = rows[0];
  return row ? requesterCommentId(row, requesterContactId) : null;
}
