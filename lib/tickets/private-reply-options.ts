import { commentIdOf, isRequesterComment } from '@/lib/meta/comments';
import { readCommentModeration } from '@/lib/meta/moderation';
import { isPrivateReplyMessage, type MetaMessageMeta } from '@/lib/meta/visibility';

/**
 * The comments the composer offers a private reply, read off the timeline the
 * ticket page already holds.
 *
 * Only the requester's (`isRequesterComment`), the question the action asks
 * again of the one it is sent (`lib/tickets/reply-comment.ts`). Pure, and apart
 * from the composer, because the composer is a client component and this is
 * the part with decisions in it.
 */

export type PrivateReplyOption = {
  /** The message's id: all the form posts, and what the action re-reads. */
  id: string;
  text: string;
  at: Date;
  /**
   * Deleted from the post through the console. Graph refuses a private reply
   * to a comment that is gone, so it is never the default — but still listed,
   * marked, because it is the customer's and the agent can see it above.
   */
  deleted: boolean;
  /**
   * A private reply to it is already sent or on its way. Meta allows one per
   * comment, ever, so a second is refused. Known only for replies that name
   * their comment, which the console's have since it started naming one.
   */
  answered: boolean;
};

type TimelineRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  authorContactId: string | null;
  meta: unknown;
  bodyText: string;
  createdAt: Date;
  deliveryStatus: string;
};

/** The requester's comments, newest first. The timeline arrives oldest first. */
export function privateReplyOptions(
  messages: readonly TimelineRow[],
  requesterContactId: string,
): PrivateReplyOption[] {
  // A failed attempt spends nothing: Graph refused it, and a retry after a real
  // failure is what an agent does next.
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.deliveryStatus === 'failed') continue;
    if (!isPrivateReplyMessage((message.meta ?? {}) as MetaMessageMeta, message.direction)) {
      continue;
    }
    const commentId = (message.meta as { commentId?: unknown }).commentId;
    if (typeof commentId === 'string' && commentId) answered.add(commentId);
  }

  return messages
    .filter((message) => isRequesterComment(message, requesterContactId))
    .map((message) => {
      const commentId = commentIdOf(message.meta, null);
      return {
        id: message.id,
        text: message.bodyText,
        at: message.createdAt,
        deleted: readCommentModeration(message.meta).deleted,
        answered: commentId !== null && answered.has(commentId),
      };
    })
    .reverse();
}

/**
 * The option chosen until the agent picks another: the customer's newest
 * comment that can still take a private reply, and their newest when none can —
 * marked, so the agent sees why Graph will refuse it.
 */
export function defaultPrivateReplyOption(
  options: readonly PrivateReplyOption[],
): string | undefined {
  return (options.find((option) => !option.deleted && !option.answered) ?? options[0])?.id;
}
