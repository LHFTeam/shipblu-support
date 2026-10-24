import { commentIdOf, isRequesterComment } from '@/lib/meta/comments';
import { readCommentModeration } from '@/lib/meta/moderation';

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
   * to a comment that is gone, so it cannot be chosen — but is still listed,
   * marked, because it is the customer's and the agent can see it above.
   */
  deleted: boolean;
  /**
   * A private reply to it is already sent or on its way. Meta allows one per
   * comment, ever, so it cannot be chosen. Known only for replies that name
   * their comment, which the console's have since it started naming one.
   */
  answered: boolean;
};

/**
 * Whether a private reply may answer it: the two refusals the action makes
 * too (`privateReplyRefusal` in `lib/tickets/reply-comment.ts`), so an option
 * the composer offers is one the action takes.
 */
export function canTakePrivateReply(option: PrivateReplyOption): boolean {
  return !option.deleted && !option.answered;
}

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
  // failure is what an agent does next. Read as the action's query reads it —
  // an outbound row the console sent as a private reply, naming its comment.
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.direction !== 'outbound' || message.deliveryStatus === 'failed') continue;
    const meta = (message.meta ?? {}) as { sendKind?: unknown; commentId?: unknown };
    if (meta.sendKind !== 'private_reply') continue;
    if (typeof meta.commentId === 'string' && meta.commentId) answered.add(meta.commentId);
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
 * comment that can still take a private reply, or none when none can.
 */
export function defaultPrivateReplyOption(
  options: readonly PrivateReplyOption[],
): string | undefined {
  return options.find(canTakePrivateReply)?.id;
}

/**
 * A comment's text on one line, short enough for an option.
 *
 * Cut at the last space that fits rather than at a fixed count, so no Arabic
 * letter is parted from its marks and no emoji from the rest of its sequence;
 * a comment with no space in the back half of the limit is cut by code point,
 * which can still split one. Not `Intl.Segmenter`, which would cut by grapheme
 * everywhere: its rules come from each engine's ICU, and this text is drawn by
 * Node and again by the browser to hydrate — a cut the two place differently
 * is a hydration error (§6.96). A space is a space in both.
 */
export function commentExcerpt(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  if (chars.length <= max) return line;

  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  return `${space > head.length / 2 ? head.slice(0, space) : head}…`;
}
