import { MetaApiError, deleteComment, latestPagePostId, replyToComment } from '@/lib/meta/client';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Makes one successful `pages_manage_engagement` call, so Meta will let us ask
 * for Advanced Access.
 *
 *   npm run job -- test_comment_permission
 *
 * The App Dashboard gates the "Request advanced access" button behind a
 * successful test call against the permission, and says it can take up to 24
 * hours to light up afterwards. There is no way to satisfy that from the
 * console — every comment reply an agent can reach is refused today (§6.42) —
 * so this is the one place the call can be made deliberately.
 *
 * **It writes to the real Facebook Page**, which is why it is a job somebody
 * types rather than anything scheduled, and why the comment is removed again in
 * the same run. Sibling of `check_meta_permissions` in every other respect: run
 * by hand, output is the whole point, and it is the fastest way to answer a
 * question that otherwise takes an afternoon.
 *
 * Two outcomes and they mean opposite things, which is the reason for the
 * commentary at the end:
 *
 *   - **It succeeds.** The scope is on the token and Standard Access covers the
 *     Page. Nothing was ever wrong with the credential; what is missing is only
 *     the Advanced Access grant, and the button should activate within a day.
 *   - **It is refused the same way the agent's reply was.** Then the scope is not
 *     on this token at all, and no number of test calls will change that — the
 *     token has to be re-minted with `pages_manage_engagement` in the OAuth
 *     scope list. Running this again is not the fix, and the message says so.
 */

type Options = {
  /** Post to comment on. Defaults to the Page's newest published post. */
  postId?: string;
  /** Leave the comment up. Off by default — this is a test, not a post. */
  keep?: boolean;
  message?: string;
};

/**
 * Innocuous on purpose, and self-explaining.
 *
 * It is visible on a public post for as long as the delete takes, and the one
 * reader who might see it is a customer. So it says what it is rather than
 * being cute or blank — "test" alone, on a support Page, reads like a mistake
 * somebody should reply to.
 */
const DEFAULT_MESSAGE = 'Automated API permission check by ShipBlu Support. Please ignore.';

export async function testCommentPermission(job: ClaimedJob): Promise<void> {
  const options = (job.payload ?? {}) as Options;
  const message = typeof options.message === 'string' ? options.message : DEFAULT_MESSAGE;

  const postId =
    typeof options.postId === 'string' && options.postId ? options.postId : await resolvePost();

  console.log(`\n[meta:test] commenting on facebook post ${postId}`);
  console.log(`[meta:test] message: ${message}`);

  let commentId: string | null;
  try {
    commentId = await replyToComment({ platform: 'facebook', commentId: postId, message });
  } catch (error) {
    explainFailure(error);
    throw error;
  }

  // A 200 with no id would mean the call was accepted and nothing was created,
  // which is not the successful call Meta is asking for — and would leave the
  // delete below with nothing to aim at.
  if (!commentId) {
    throw new Error(
      'Graph accepted the comment but returned no id, so nothing can be confirmed or cleaned up',
    );
  }

  console.log(`[meta:test] ✓ created comment ${commentId}`);
  console.log('[meta:test] ✓ pages_manage_engagement accepted a write on this Page');

  if (options.keep === true) {
    console.log(`\n[meta:test] keep=true — comment ${commentId} is still live. Remove it by hand.`);
  } else {
    // Deleting is itself a `pages_manage_engagement` call, so a clean run has
    // exercised the permission twice, in both directions. It is also the only
    // thing standing between a test and a public comment on the Page, so a
    // failure here is reported loudly with the id needed to finish by hand
    // rather than swallowed.
    try {
      await deleteComment({ platform: 'facebook', commentId });
      console.log(`[meta:test] ✓ deleted comment ${commentId} — nothing left on the post`);
    } catch (error) {
      console.error(
        `[meta:test] the comment was created but NOT deleted. It is live on the Page as ` +
          `${commentId} and needs removing by hand.`,
      );
      throw error;
    }
  }

  console.log(
    '\n[meta:test] The test call Meta asks for has now been made. Open the app dashboard →' +
      '\n[meta:test] Permissions → pages_manage_engagement and request Advanced Access. The' +
      '\n[meta:test] button can take up to 24 hours to activate after the first call.\n',
  );
}

async function resolvePost(): Promise<string> {
  const postId = await latestPagePostId();

  if (!postId) {
    throw new Error(
      'The Page has no published post to comment on. Publish one, or pass postId=<id>.',
    );
  }

  return postId;
}

/**
 * Says which of the two failures this was, because they need opposite responses
 * and Graph words them identically.
 */
function explainFailure(error: unknown): void {
  if (!(error instanceof MetaApiError)) return;

  // The same three codes `lib/meta/errors.ts` treats as "Graph refused the app,
  // not the request".
  if (error.code === 200 || error.code === 3 || error.code === 10) {
    console.error(
      `\n[meta:test] Refused exactly as the agent's reply was (code ${error.code}).\n` +
        `[meta:test] This is not the Advanced Access grant — a test call cannot earn a\n` +
        `[meta:test] permission the token does not carry at all. Run\n` +
        `[meta:test]   npm run job -- check_meta_permissions\n` +
        `[meta:test] and check whether pages_manage_engagement is in the scope list, and\n` +
        `[meta:test] whether granular_scopes names this Page. If it is absent, the Page\n` +
        `[meta:test] token has to be re-minted with that scope; running this again will\n` +
        `[meta:test] fail the same way.\n`,
    );
    return;
  }

  if (error.code === 100) {
    console.error(
      `\n[meta:test] Graph would not accept the post this comment was addressed to.\n` +
        `[meta:test] Pass postId=<id> naming a post the Page itself published.\n`,
    );
  }
}
