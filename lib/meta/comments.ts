import type { MetaPlatform } from './types';

/**
 * Comment operations, as Graph requests, per platform.
 *
 * This is a pure module and not part of `lib/meta/client.ts` because the two
 * platforms disagree about every single one of these calls, and the
 * disagreements are not visible in a response: Graph refuses a wrong-shaped
 * comment request with `100 "Unsupported post request"` — the same sentence it
 * uses for a deleted object — so a mistake here reads in the log as "that
 * comment is gone" rather than as "we asked the wrong endpoint".
 *
 * Facebook treats a comment as another node with a `comments` edge, and updates
 * it with `is_hidden`. Instagram gives a comment a `replies` edge instead,
 * spells the same update `hide`, and does not have a private-reply edge at all —
 * a private reply there is a *message* addressed to a comment id. Every one of
 * those was previously issued in the Facebook shape on both platforms, because
 * the functions took a comment id and no platform, which made the difference
 * impossible to express. No Instagram comment reply this system sent could ever
 * have been delivered.
 *
 * Written as data rather than as branches inside the client so the shapes can be
 * asserted against Meta's reference in a unit test, which is the only check
 * available: nothing local can call Graph, and the failures are indistinguishable
 * from ordinary ones once they arrive.
 */

export type CommentOperation =
  | { kind: 'reply'; message: string }
  | { kind: 'private_reply'; message: string }
  | { kind: 'hide'; hidden: boolean }
  | { kind: 'delete' };

export type GraphRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

export type CommentRequestInput = {
  platform: MetaPlatform;
  commentId: string;
  /**
   * The account replies go out from. Only Instagram's private reply needs it —
   * it is addressed to the account rather than to the comment — but it is
   * required for every input so a caller cannot reach that one case having
   * resolved nothing, which is how the account id came to be missing from the
   * only call that needed it.
   */
  accountId: string;
  operation: CommentOperation;
};

export function commentRequest(input: CommentRequestInput): GraphRequest {
  const { platform, commentId, accountId, operation } = input;

  switch (operation.kind) {
    case 'reply':
      return {
        method: 'POST',
        // Instagram's comment node has a `replies` edge and no `comments` one.
        path: platform === 'instagram' ? `${commentId}/replies` : `${commentId}/comments`,
        body: { message: operation.message },
      };

    case 'private_reply':
      if (platform === 'facebook') {
        return {
          method: 'POST',
          path: `${commentId}/private_replies`,
          body: { message: operation.message },
        };
      }

      /*
        Instagram has no private-reply edge. The same thing is done by sending a
        message from the account with a *comment id* where a recipient id would
        normally go, which is what makes the send legal without the customer
        having written in first.

        Deliberately not folded into `sendDirectMessage`: that function's
        recipient is a person and its tag decides whether the 24-hour window
        applies, neither of which is true here — this send is bounded by the
        comment's own seven days and takes no tag at all. Sharing the code would
        mean a parameter meaning "ignore most of this function".
      */
      return {
        method: 'POST',
        path: `${accountId}/messages`,
        body: {
          recipient: { comment_id: commentId },
          message: { text: operation.message },
        },
      };

    case 'hide':
      return {
        method: 'POST',
        path: commentId,
        /*
          As a query parameter rather than a JSON body, on both platforms.

          Graph accepts either for a node update, but these two are the only
          calls in this module with no message to carry, and a POST whose entire
          content is one boolean is far easier to read in a log — and to
          reproduce with curl — as part of the URL. The body form is what the
          previous, never-executed `hideComment` used.
        */
        query:
          platform === 'instagram'
            ? { hide: String(operation.hidden) }
            : { is_hidden: String(operation.hidden) },
      };

    case 'delete':
      // Identical on both platforms, and the one comment operation that is.
      return { method: 'DELETE', path: commentId };
  }
}

/**
 * The comment a public reply should be posted against, given the ticket.
 *
 * Instagram comment threads are one level deep: every reply, whoever wrote it,
 * hangs off the top-level comment, and `replies` is an edge of that comment
 * alone. So once a customer has answered inside a thread, the newest inbound
 * comment is a reply — and posting to *its* `replies` edge is not the same
 * request, it is a request for an edge that does not exist there.
 *
 * The root id is already known: `ingestMetaComment` keys the ticket on it, as
 * `instagram:comment:<root>`. This reads it back rather than re-deriving it from
 * the timeline, because the timeline can begin mid-thread — the root comment
 * itself is only ingested if it arrived while the webhook was subscribed.
 *
 * Facebook keeps the specific comment: its own reply lands in the right thread
 * either way, and answering directly under what the customer wrote is what an
 * agent means by "reply".
 */
export function commentReplyTarget(input: {
  platform: MetaPlatform;
  externalId: string | null;
  /** The comment the agent is answering — the newest inbound one. */
  lastCommentId: string | null;
}): string | null {
  const root = rootCommentId(input.externalId);

  return input.platform === 'instagram'
    ? (root ?? input.lastCommentId)
    : (input.lastCommentId ?? root);
}

/**
 * The root comment id out of a comment ticket's `external_id`.
 *
 * Null for anything else, including a direct-message ticket, so a caller can
 * ask without first establishing what kind of ticket it has.
 */
export function rootCommentId(externalId: string | null): string | null {
  if (!externalId) return null;

  const match = /^(?:facebook|instagram):comment:(.+)$/.exec(externalId);
  return match?.[1] ?? null;
}
