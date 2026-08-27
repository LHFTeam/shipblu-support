import { explainAuthError } from '@/lib/whatsapp/errors';
import { ACCESS_TOKEN_CODE, MetaApiError } from './client';
import type { MetaPlatform } from './types';

/**
 * Turning a Graph rejection into something an agent can act on.
 *
 * The Messenger and Instagram send APIs answer a policy refusal with "An
 * unknown error has occurred." and a code — no wording that names the rule, and
 * nothing an agent reading their timeline can do anything with. The code,
 * subcode and trace id are the only things that identify the refusal, and until
 * now they were dropped on the floor: the message row kept Meta's sentence and
 * nothing else, so a failure could only be diagnosed by guessing.
 *
 * This does what `lib/whatsapp/errors` does for that channel — keeps Meta's own
 * text, adds the explanation when the text would mislead, and always records
 * the numbers underneath it.
 */

export type MetaSendContext = {
  platform: MetaPlatform;
  sendKind: 'dm' | 'comment_reply' | 'private_reply';
  /** The tag a direct message went out with, when it was a direct message. */
  tag?: 'RESPONSE' | 'HUMAN_AGENT' | null;
};

/**
 * Meta's placeholder codes. Both mean "something was refused and we are not
 * saying what", which is exactly the case that needs the explanation below.
 */
const UNSPECIFIED_CODES = new Set([1, 2]);

export function explainMetaSendError(error: MetaApiError, context: MetaSendContext): string {
  const base = error.userMessage ?? error.message;

  /*
    A refusal this app made itself is already the explanation.

    The send path stops a reply it knows Graph will refuse — a thread another
    tool holds control of, a page this deployment cannot address — and raises
    the same error type so the job treats it as final. Nothing below applies to
    those: there is no Meta code to interpret and no Meta reference to quote,
    and running one through the guesses here would replace a sentence that says
    exactly what is wrong with one that speculates.
  */
  if (!cameFromGraph(error)) return base;

  // An expired token fails every send on every channel identically, so say that
  // rather than letting an agent read it as something they or the customer did.
  if (error.code === ACCESS_TOKEN_CODE)
    return withReference(explainAuthError(error.code, base), error);

  if (isUnspecified(error) && context.sendKind === 'dm' && context.tag === 'HUMAN_AGENT') {
    return withReference(`${base}\n\n${humanAgentExplanation(context.platform)}`, error);
  }

  // Inside the 24 hours the refusal has no tag to blame, and the two causes
  // that used to produce it are now refused before the request is made — so
  // what is left is genuinely unaccounted for, and saying which possibilities
  // have already been ruled out is what stops the next person re-checking them.
  if (isUnspecified(error) && context.sendKind === 'dm' && context.tag === 'RESPONSE') {
    return withReference(`${base}\n\n${insideWindowExplanation(context.platform)}`, error);
  }

  return withReference(base, error);
}

function isUnspecified(error: MetaApiError): boolean {
  return error.code === null || UNSPECIFIED_CODES.has(error.code);
}

// --- Profile lookups --------------------------------------------------------

/**
 * How Graph refuses a read the app has not been granted the capability for.
 *
 *   3       "Application does not have the capability to make this API call."
 *           **The one production actually returns.** Every Messenger profile
 *           lookup between 2026-08-26 and 2026-08-27 was refused this way
 *           (HTTP 400, no subcode, e.g. trace `Atd8Vvy9gSxtvIvt-INHquE`) while
 *           this set held only the three below — so the App Review sentence
 *           underneath never printed for the one case it was written for, and
 *           the refusal read as an unexplained failure. It was omitted because
 *           the set was assembled from the docs rather than from a real refusal.
 *   100/33  "Unsupported get request. Object with ID … does not exist, cannot
 *           be loaded due to missing permissions, or does not support this
 *           operation." Note what it conflates: a deleted user and an
 *           unapproved app produce the identical sentence.
 *   200     "Permissions error" — the explicit form.
 *   10      "Application does not have permission for this action" on a GET.
 *           The same number means "outside the messaging window" on a send,
 *           which is why this set is scoped to reads and not shared with
 *           `explainMetaSendError` above.
 *
 * A bare `100` is deliberately absent: it is Graph's generic "bad request",
 * covering a field name we got wrong and the Instagram linkage failure below.
 * Treating it as a missing approval would send somebody to App Review to look
 * for a feature that is already granted.
 */
const CAPABILITY_CODE = 3;
const PROFILE_PERMISSION_CODES = new Set([CAPABILITY_CODE, 10, 200]);
const UNSUPPORTED_GET_CODE = 100;
const UNSUPPORTED_GET_SUBCODE = 33;

export function isProfilePermissionRefusal(error: MetaApiError): boolean {
  if (error.code === null) return false;
  if (PROFILE_PERMISSION_CODES.has(error.code)) return true;

  return error.code === UNSUPPORTED_GET_CODE && error.subcode === UNSUPPORTED_GET_SUBCODE;
}

/**
 * The Instagram refusal that is **not** about permissions.
 *
 *   (#100) The page is not linked to an Instagram account or the linked IG
 *          account is not professional account
 *
 * Every Instagram profile lookup in production returns this, and no amount of
 * App Review will change it: the Page and the Instagram account are not linked,
 * or the account is personal rather than professional. It arrives as a bare
 * `100`, which is also what a malformed field list returns, so the wording is
 * the only thing that identifies it — the same reasoning as everywhere else in
 * this file, where the code alone does not say enough.
 */
function isInstagramLinkFailure(error: MetaApiError): boolean {
  if (error.code !== UNSUPPORTED_GET_CODE) return false;

  const text = `${error.userMessage ?? ''} ${error.message}`.toLowerCase();
  return text.includes('not linked to an instagram account') || text.includes('professional');
}

/**
 * What to write in the worker log when a profile lookup fails.
 *
 * The refusal that matters is indistinguishable from the harmless one by its
 * sentence alone, and it fails for *every* customer rather than for one — so an
 * unapproved app looks exactly like a run of private profiles unless something
 * says so out loud. This is the sentence that was missing when the Human Agent
 * feature turned out never to have been approved (`docs/PROJECT-STATE.md` §5.2);
 * the diagnosis cost eight failed sends and a guess.
 */
export function explainMetaProfileError(error: MetaApiError, platform: MetaPlatform): string {
  const base = error.userMessage ?? error.message;

  if (error.code === ACCESS_TOKEN_CODE)
    return withReference(explainAuthError(error.code, base), error);

  // Checked before the permission case, because this is the refusal that would
  // otherwise be read as one. Sending somebody to App Review for it wastes the
  // trip: the feature could be granted tomorrow and every Instagram lookup would
  // still fail exactly like this.
  if (isInstagramLinkFailure(error)) {
    return withReference(
      `${base}\n\nThis is a **configuration** problem, not an approval one, and App Review ` +
        `cannot fix it. The Instagram account must be a *professional* account (Business or ` +
        `Creator) and it must be linked to the Facebook Page this app sends from — check the ` +
        `Page's Linked Accounts settings and that INSTAGRAM_ACCOUNT_ID names that account. ` +
        `Until both are true, every Instagram profile lookup fails this way no matter which ` +
        `permissions the app holds.`,
      error,
    );
  }

  if (isProfilePermissionRefusal(error)) {
    const product = platform === 'instagram' ? 'Instagram' : 'Messenger';

    // Code 3 names the cause outright — the app lacks the capability — so it
    // needs no hedging. The others genuinely cannot tell an unapproved app from
    // a customer who is gone, and saying so is what stops the reader concluding
    // it was this one person.
    const ambiguity =
      error.code === CAPABILITY_CODE
        ? `Graph is saying the app does not hold the capability, which is not a property of ` +
          `this customer — it will refuse every ${product} profile identically.`
        : `Graph answers this way both when the person is gone and when the app is not ` +
          `approved, and the two are not distinguishable from the message — so check the ` +
          `feature before assuming it is the customer.`;

    return withReference(
      `${base}\n\nGraph refused a ${product} profile read. ${ambiguity} Check **Business Asset ` +
        `User Profile Access** under App Review for the Meta app. Until it is granted, every ` +
        `${product} ticket stays filed under a bare numeric id, which is what this call exists ` +
        `to prevent — and nothing is lost meanwhile: the identity is left unstamped, so approval ` +
        `repairs the archive by itself.`,
      error,
    );
  }

  return withReference(base, error);
}

// --- Comment moderation -----------------------------------------------------

/**
 * What to put on a comment whose hide, unhide or delete Graph refused.
 *
 * The same lesson as the two above, on the third permission it applies to.
 * Comment management is gated by its own App Review item, and a refusal for the
 * missing approval arrives as `100/33 "Unsupported post request"` — the very
 * sentence Graph also uses for a comment somebody has already deleted from the
 * app. Those need opposite responses: one is a dashboard problem affecting every
 * comment until somebody fixes it, the other is normal and final.
 *
 * The permission is named per platform, and named as it appears in App Review
 * rather than as a paraphrase, because the two flows spell it differently and an
 * agent reading this is going to hand the sentence to whoever holds the Meta
 * dashboard.
 */
export function explainMetaModerationError(
  error: MetaApiError,
  context: { platform: MetaPlatform; action: 'hide' | 'unhide' | 'delete' },
): string {
  const base = error.userMessage ?? error.message;

  if (!cameFromGraph(error)) return base;

  if (error.code === ACCESS_TOKEN_CODE)
    return withReference(explainAuthError(error.code, base), error);

  if (isProfilePermissionRefusal(error)) {
    const permission =
      context.platform === 'instagram'
        ? '**instagram_business_manage_comments** (or **instagram_manage_comments**, if the ' +
          'account is connected through its Facebook Page)'
        : '**pages_manage_engagement**';

    return withReference(
      `${base}\n\nGraph refused a request to ${context.action} this comment. It answers this ` +
        `way both when the comment is already gone and when the app is not approved for ` +
        `${permission}, and the message does not distinguish them — so check that permission ` +
        `under App Review before assuming the comment was deleted. Until it is granted, no ` +
        `comment can be hidden or deleted from here, while public replies keep working.`,
      error,
    );
  }

  return withReference(base, error);
}

/** Graph answered. A status of 0 with no code means the request never got there. */
function cameFromGraph(error: MetaApiError): boolean {
  return error.status !== 0 || error.code !== null;
}

/**
 * The 24-hour-to-7-day path, which is the one an agent hits without ever
 * choosing it: they answer a ticket the next working day and the send quietly
 * changes shape underneath them.
 */
function humanAgentExplanation(platform: MetaPlatform): string {
  const product = platform === 'instagram' ? 'Instagram' : 'Messenger';

  return (
    `This reply went out more than 24 hours after the customer's last message, ` +
    `so it was tagged HUMAN_AGENT — the only way to answer inside the 7-day ` +
    `window. ${product} refused it without naming a reason, which is what it ` +
    `returns when the Meta app is not approved for the Human Agent feature: ` +
    `that one needs App Review and business verification, and until it is ` +
    `granted every reply between 24 hours and 7 days fails this way while ` +
    `replies inside 24 hours keep working. Check Human Agent under App Review ` +
    `for the Meta app. If it is already approved, nothing sends until the ` +
    `customer messages again and reopens the 24-hour window.`
  );
}

/**
 * The refusal that arrives while everything we can check is in order.
 *
 * Worth its own sentence because it looks exactly like the two failures that
 * are now caught before the send — same code, same sentence, same HTTP 500 —
 * and an agent who has seen those would reasonably assume it is one of them
 * again.
 */
function insideWindowExplanation(platform: MetaPlatform): string {
  const product = platform === 'instagram' ? 'Instagram' : 'Messenger';

  return (
    `This reply was inside the 24-hour window, on the account the ticket arrived on, ` +
    `and in a thread this app holds control of — so ${product} refused it for a reason ` +
    `it did not give and none of the usual ones apply. Check the Meta app for a ` +
    `restriction or a policy block, and whether the customer has blocked the ` +
    `${platform === 'instagram' ? 'account' : 'page'}. The trace id below is what Meta ` +
    `support asks for.`
  );
}

/**
 * The identifiers Meta's own support asks for, kept on the message so they are
 * still there when someone looks a week later.
 *
 * Only ever reached for an error Graph actually answered with; our own
 * refusals return above, before there is an empty reference to print.
 */
function withReference(text: string, error: MetaApiError): string {
  const parts = [
    `code ${error.code ?? '—'}`,
    `subcode ${error.subcode ?? '—'}`,
    `HTTP ${error.status}`,
  ];
  if (error.traceId) parts.push(`trace ${error.traceId}`);

  return `${text}\n\n(Meta: ${parts.join(', ')})`;
}
