import { explainAuthError } from '@/lib/whatsapp/errors';
import { ACCESS_TOKEN_CODE, MetaApiError } from './client';
import { CONNECTION_HOST, CONNECTION_LABEL, type MetaConnection } from './connection';
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
  /**
   * The connection the send went out over.
   *
   * Recorded in the reference line rather than in the prose, because it is the
   * first thing to check on an Instagram refusal and the last thing anybody can
   * reconstruct afterwards: the two connections use different hosts, different
   * credentials and differently named App Review permissions, and Graph refuses
   * both with the same sentence.
   */
  connection: MetaConnection;
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
    return withReference(explainAuthError(error.code, base), error, context.connection);

  if (isUnspecified(error) && context.sendKind === 'dm' && context.tag === 'HUMAN_AGENT') {
    return withReference(
      `${base}\n\n${humanAgentExplanation(context.platform)}`,
      error,
      context.connection,
    );
  }

  /*
    A reply posted at a comment Graph would not accept.

    Checked before the direct-message branches only in the sense that it cannot
    collide with them — they require `sendKind === 'dm'` — but it is the branch
    that matters most in practice, because **nothing else in the system will
    ever say a comment is gone.** Verified on 2026-08-30 at the request log
    rather than the database, which rules out a delivery that arrived and was
    not stored: a comment deleted on Instagram produces no webhook at all. Not a
    `remove` verb, not an empty change — no HTTP request. So the ticket goes on
    showing a comment that no longer exists publicly, and the first and only
    time anybody learns otherwise is when an agent's reply is refused.

    Facebook is not the same: a deletion arrives as `feed` with `verb: remove`,
    which `lib/meta/parse.ts` drops. It still does not mark the ticket, so the
    reply fails the same way — the sentence below is worth printing on both.
  */
  /*
    The app is not allowed to manage comments on this asset at all.

    Checked before the target refusal below because it is the one production has
    actually returned, and because the two need opposite responses: that one is
    usually a customer deleting their own comment and needs no action, this one
    fails every comment reply on the Page until somebody changes an approval.
    Graph tells them apart by code — 200 rather than 100/33 — which is the only
    signal there is, since the sentence it ships with says nothing either way.
  */
  if (context.sendKind !== 'dm' && isCommentPermissionRefusal(error)) {
    return withReference(
      `${base}\n\n${commentPermissionExplanation(context)}`,
      error,
      context.connection,
    );
  }

  if (context.sendKind !== 'dm' && isCommentTargetRefusal(error)) {
    return withReference(
      `${base}\n\n${commentTargetExplanation(context)}`,
      error,
      context.connection,
    );
  }

  // Inside the 24 hours the refusal has no tag to blame, and the two causes
  // that used to produce it are now refused before the request is made — so
  // what is left is genuinely unaccounted for, and saying which possibilities
  // have already been ruled out is what stops the next person re-checking them.
  if (isUnspecified(error) && context.sendKind === 'dm' && context.tag === 'RESPONSE') {
    return withReference(
      `${base}\n\n${insideWindowExplanation(context.platform, context.connection)}`,
      error,
      context.connection,
    );
  }

  return withReference(base, error, context.connection);
}

function isUnspecified(error: MetaApiError): boolean {
  return error.code === null || UNSPECIFIED_CODES.has(error.code);
}

/**
 * Graph would not accept the comment this reply was addressed to.
 *
 * `100/33` is Meta's documented "Object with ID … does not exist, cannot be
 * loaded due to missing permissions, or does not support this operation", and a
 * bare `100` is the same refusal without the subcode. Both say the node was
 * rejected and neither says which of the three reasons it was — which is the
 * whole point of the sentence below.
 *
 * **Not observed against the real Graph**, like most of this file: no comment
 * reply has ever been refused in production, because none has ever been sent.
 * So it is matched on Meta's documented shape and kept narrow deliberately —
 * anything else falls through to the generic branch, which prints Graph's own
 * words and the reference. Silent beats confidently wrong, the same trade
 * `isInstagramLinkageRefusal` makes. If a real refusal arrives wearing a
 * different code, read it out of the log and widen this rather than guessing
 * now (§6.27: a diagnostic keyed on a code nobody verified is silent exactly
 * when it is needed).
 */
const COMMENT_TARGET_CODE = 100;
const COMMENT_TARGET_SUBCODE = 33;

function isCommentTargetRefusal(error: MetaApiError): boolean {
  if (error.code !== COMMENT_TARGET_CODE) return false;
  return error.subcode === COMMENT_TARGET_SUBCODE || error.subcode === null;
}

/**
 * Graph refused the *capability*, not the comment.
 *
 * **Observed**, unlike the target refusal above. The first comment reply this
 * system ever attempted — 2026-09-01 12:25 UTC, ticket #13755 — came back
 * `HTTP 403, code 200, "(#200) Permissions error"` from
 * `POST /<comment id>/comments`, and fell through every branch here to print
 * that sentence and nothing else. "Permissions error" is not a sentence an agent
 * can act on: it names no permission, no asset and no remedy, and it is
 * indistinguishable at a glance from the customer having deleted their comment.
 *
 * The codes are the same three the profile lookups already treat this way —
 * `3` "does not have the capability", `10` "does not have permission", `200`
 * the explicit form — which is not a coincidence: they are how Graph refuses an
 * app rather than a request, whatever the edge. Kept as its own set rather than
 * shared with `PROFILE_PERMISSION_CODES` because that one also folds in the
 * 100/33 unsupported-get shape, which on this path means the opposite thing.
 */
const COMMENT_PERMISSION_CODES = new Set([3, 10, 200]);

function isCommentPermissionRefusal(error: MetaApiError): boolean {
  return error.code !== null && COMMENT_PERMISSION_CODES.has(error.code);
}

/** The App Review permission that governs comment management on this channel. */
function commentPermission(context: MetaSendContext): string {
  if (context.platform === 'facebook') return '`pages_manage_engagement`';
  return context.connection === 'instagram_login'
    ? '`instagram_business_manage_comments`'
    : '`instagram_manage_comments`';
}

/**
 * Ordered the other way round from `commentTargetExplanation`, and for the same
 * reason it is ordered as it is: by what this particular code makes likely. An
 * approval gap is the first thing to check here rather than the last, because
 * Graph reached for the permission code instead of the object one.
 */
function commentPermissionExplanation(context: MetaSendContext): string {
  const permission = commentPermission(context);
  const asset = context.platform === 'facebook' ? 'Page' : 'Instagram account';

  const privately =
    context.sendKind === 'private_reply'
      ? `\n\nA private reply needs ${permission} too — the same approval covers both, so a ` +
        `public reply will be refused the same way until it is granted.`
      : `\n\nThe customer can still be answered privately if the comment is less than seven ` +
        `days old: **Reply privately** moves the thread into the DM inbox, which is governed ` +
        `by messaging permissions rather than this one.`;

  return (
    `Graph refused the app, not the comment. This is a permission on the credential, so it ` +
    `fails **every** comment reply on this ${asset} rather than this one — if a reply has ` +
    `ever succeeded here, look elsewhere.\n\n` +
    `Comment management needs ${permission} at **Advanced Access**, granted for this ` +
    `${asset} specifically. Standard Access is not enough on a Page the app does not own, and ` +
    `a scope granted for a different asset reads as granted everywhere else — run ` +
    `\`npm run job -- check_meta_permissions\`, which prints the token's scopes and the ` +
    `\`granular_scopes\` list saying which assets each one was actually granted for.` +
    privately
  );
}

/**
 * The three things this refusal can mean, in the order they are worth checking.
 *
 * Ordered by likelihood rather than by severity, which is the opposite of how
 * the profile explanation is ordered and is right here: a customer deleting
 * their own comment is ordinary and needs no fix, while an unapproved
 * permission would have failed every comment reply rather than this one.
 */
function commentTargetExplanation(context: MetaSendContext): string {
  const permission = commentPermission(context);

  const oneOff =
    context.sendKind === 'private_reply'
      ? `\n\n**A private reply is also allowed exactly once per comment, ever, and only ` +
        `within seven days of it.** If one has already been sent against this comment, or the ` +
        `seven days have passed, Graph refuses it in this same shape. That send is not ` +
        `retried automatically for exactly this reason.`
      : '';

  const wrongNode =
    context.platform === 'instagram' && context.sendKind === 'comment_reply'
      ? `\n\n**2. The wrong comment was addressed.** Instagram threads are one level deep: ` +
        `every reply hangs off the *top-level* comment, and \`replies\` is an edge of that ` +
        `comment alone. Posting to a reply's own \`replies\` edge asks for an edge that does ` +
        `not exist and is refused this way. \`commentReplyTarget\` resolves the root from the ` +
        `ticket's \`external_id\`, so this means the ticket began mid-thread and the root was ` +
        `never ingested.`
      : '';

  return (
    `Graph refused the comment this reply was addressed to. Three things produce this and ` +
    `they need different responses.\n\n` +
    `**1. The comment is gone.** The customer deleted it, or the post was removed. This is ` +
    `the likeliest cause and there is nothing to fix — but nothing told us either: ` +
    `**Instagram sends no webhook when a comment is deleted**, so the ticket still shows it ` +
    `and this refusal is the first sign. Open the post and check before reading further.` +
    wrongNode +
    `\n\n**${wrongNode ? '3' : '2'}. The approval.** Comment management needs ${permission} ` +
    `at Advanced Access. That one fails *every* comment reply rather than this one, so it is ` +
    `only the answer if no reply has ever succeeded — \`npm run job -- check_meta_permissions\` ` +
    `says which permissions the credential actually carries.` +
    oneOff
  );
}

// --- Profile lookups --------------------------------------------------------

/**
 * How Graph refuses a profile read the app is not approved for.
 *
 *   3       "Application does not have the capability to make this API call."
 *           **The one production actually returns.** Eleven Messenger lookups
 *           between 2026-08-26 15:26 and 2026-08-27 11:56 UTC were refused this
 *           way, none of them matched this set as it stood, and so the sentence
 *           this file exists to print never printed once — the same silence that
 *           cost eight sends over the Human Agent feature. It is also the only
 *           code here that names the *app* rather than the object, which is why
 *           it is the least ambiguous of the four.
 *   100/33  "Unsupported get request. Object with ID … does not exist, cannot
 *           be loaded due to missing permissions, or does not support this
 *           operation." What Meta's documentation describes, and note what it
 *           conflates: a deleted user and an unapproved app produce the
 *           identical sentence. Kept for that reason, not because it has ever
 *           arrived here.
 *   200     "Permissions error" — the explicit form.
 *   10      "Application does not have permission for this action" on a GET.
 *           The same number means "outside the messaging window" on a send,
 *           which is why this set is scoped to profile reads and not shared
 *           with `explainMetaSendError` above.
 */
const PROFILE_PERMISSION_CODES = new Set([3, 10, 200]);
const UNSUPPORTED_GET_CODE = 100;
const UNSUPPORTED_GET_SUBCODE = 33;

export function isProfilePermissionRefusal(error: MetaApiError): boolean {
  if (error.code === null) return false;
  if (PROFILE_PERMISSION_CODES.has(error.code)) return true;

  return error.code === UNSUPPORTED_GET_CODE && error.subcode === UNSUPPORTED_GET_SUBCODE;
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

  // Checked before the permission branch, because this one is not App Review at
  // all and sending somebody to that dashboard would cost them the afternoon.
  if (isInstagramLinkageRefusal(error, platform)) {
    return withReference(
      `${base}\n\nThis is not an App Review problem: Graph is saying the Page token has no ` +
        `route to this Instagram-scoped id, which is what it answers when the professional ` +
        `account is not linked to the Page. It also means the call went out over the ` +
        `**Facebook Page connection**, because that is the only one that uses the Page token ` +
        `— so either the account is not linked to the Page, or it is meant to be reached ` +
        `directly and INSTAGRAM_ACCESS_TOKEN is not set. Setting that token moves every ` +
        `Instagram call to graph.instagram.com; \`metaConnection()\` in ` +
        `lib/meta/connection.ts keys on it being present, not on a mode flag. Until one of ` +
        `the two is true, every Instagram profile read, send and moderation call goes out ` +
        `with a credential that cannot address the account, and Business Asset User Profile ` +
        `Access cannot rescue it, because the request never reaches the feature.`,
      error,
    );
  }

  if (isProfilePermissionRefusal(error)) {
    const product = platform === 'instagram' ? 'Instagram' : 'Messenger';

    return withReference(
      `${base}\n\nGraph refused a ${product} profile read. Three different faults produce this ` +
        `and they need three different fixes, so check them in this order.\n\n` +
        `**1. The token type.** A page-scoped id can only be resolved by that Page's own token. ` +
        `A System User or User token is refused exactly this way, whatever its scopes say — and ` +
        `on 2026-08-27 that was the cause, after a day spent reading it as a missing approval. ` +
        `Paste META_PAGE_ACCESS_TOKEN into Meta's Access Token Debugger: it must say Type: Page.` +
        `\n\n**2. The approval.** If the token is a Page token, this is **Business Asset User ` +
        `Profile Access** at Advanced Access. The tell is decisive: people with a role on the ` +
        `Meta app are exempt, so if your own account resolves and a customer does not, it is ` +
        `this and only App Review fixes it.\n\n**3. The customer.** Graph says the same thing ` +
        `for somebody who has deleted their account. Only conclude this once the first two are ` +
        `ruled out, because it is the one that looks like nothing is wrong.`,
      error,
    );
  }

  return withReference(base, error);
}

/**
 * A Page token asked about an Instagram id it cannot reach.
 *
 * `(#100) The page is not linked to an Instagram account or the linked IG
 * account is not professional account`. Six Instagram lookups on 2026-08-27
 * came back this way, from graph.facebook.com, because no
 * `INSTAGRAM_ACCESS_TOKEN` was set and `endpoint()` therefore fell back to the
 * Page token and the Facebook host. It is a bare 100, so
 * `isProfilePermissionRefusal` rightly declines it — and without this it would
 * be explained as a malformed request, which is the one reading that would send
 * the next person looking for the fault in this repo.
 *
 * Matched on the wording as well as the code, deliberately. A bare 100 usually
 * *is* a malformed request, and answering a field name we typed wrong with
 * "check your Instagram connection" trades one wrong diagnosis for another. If
 * Meta rewords the sentence this stops matching and the generic explanation
 * returns: silent rather than confidently wrong.
 */
function isInstagramLinkageRefusal(error: MetaApiError, platform: MetaPlatform): boolean {
  if (platform !== 'instagram') return false;
  if (error.code !== UNSUPPORTED_GET_CODE || error.subcode !== null) return false;

  return /not linked to an instagram account|not professional account/i.test(error.message);
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
  context: {
    platform: MetaPlatform;
    connection: MetaConnection;
    action: 'hide' | 'unhide' | 'delete';
  },
): string {
  const base = error.userMessage ?? error.message;

  if (!cameFromGraph(error)) return base;

  if (error.code === ACCESS_TOKEN_CODE)
    return withReference(explainAuthError(error.code, base), error, context.connection);

  if (isProfilePermissionRefusal(error)) {
    // Named for the connection the call actually went out over rather than
    // offering both and letting the reader pick. Both spellings exist on this
    // app because both connections are live, and handing somebody two
    // permission names for one refusal is how an approval gets requested on the
    // flow that was not being used.
    const permission =
      context.platform === 'instagram'
        ? context.connection === 'instagram_login'
          ? '**instagram_business_manage_comments**'
          : '**instagram_manage_comments**'
        : '**pages_manage_engagement**';

    return withReference(
      `${base}\n\nGraph refused a request to ${context.action} this comment. It answers this ` +
        `way both when the comment is already gone and when the app is not approved for ` +
        `${permission}, and the message does not distinguish them — so check that permission ` +
        `under App Review before assuming the comment was deleted. Until it is granted, no ` +
        `comment can be hidden or deleted from here, while public replies keep working.`,
      error,
      context.connection,
    );
  }

  return withReference(base, error, context.connection);
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
function insideWindowExplanation(platform: MetaPlatform, connection: MetaConnection): string {
  const product = platform === 'instagram' ? 'Instagram' : 'Messenger';

  return (
    `This reply was inside the 24-hour window, on the account the ticket arrived on, ` +
    `and in a thread this app holds control of — so ${product} refused it for a reason ` +
    `it did not give and none of the usual ones apply. It went out over ` +
    `${CONNECTION_LABEL[connection]}, so check that one's credential and permissions ` +
    `rather than the other's` +
    (connection === 'instagram_login'
      ? ` — INSTAGRAM_ACCESS_TOKEN and the instagram_business_* set, not the Page token`
      : '') +
    `. Then check the Meta app for a restriction or a policy block, and whether the ` +
    `customer has blocked the ${platform === 'instagram' ? 'account' : 'page'}. The trace ` +
    `id below is what Meta support asks for.`
  );
}

/**
 * The identifiers Meta's own support asks for, kept on the message so they are
 * still there when someone looks a week later.
 *
 * Only ever reached for an error Graph actually answered with; our own
 * refusals return above, before there is an empty reference to print.
 */
function withReference(text: string, error: MetaApiError, connection?: MetaConnection): string {
  const parts = [
    `code ${error.code ?? '—'}`,
    `subcode ${error.subcode ?? '—'}`,
    `HTTP ${error.status}`,
  ];
  if (error.traceId) parts.push(`trace ${error.traceId}`);
  // Which host answered. Two connections, two origins, identical refusals —
  // and a refusal whose host is unknown cannot be told from one whose
  // credential is.
  if (connection) parts.push(`via ${CONNECTION_HOST[connection]}`);

  return `${text}\n\n(Meta: ${parts.join(', ')})`;
}
