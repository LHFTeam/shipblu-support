import { env } from '@/lib/env';
import { commentRequest, type CommentOperation } from './comments';
import { parseThreadOwner, type ThreadOwnerReading } from './control';
import type { MetaPlatform } from './types';

/**
 * Graph API client for Messenger and Instagram.
 *
 * Separate from `lib/whatsapp/client` even though both talk to graph.facebook.com:
 * the endpoints, the id types and the failure modes have nothing in common, and
 * folding them together would produce a client whose every function takes a
 * "which product is this?" flag.
 *
 * Both platforms are addressed through the *Facebook Page* token. An Instagram
 * professional account is reached at `/{ig-account-id}/messages` with the same
 * page token, which is why there is one credential here and not two.
 */

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Instagram Login's own host. Same version, same paths, different origin and a
 * different credential — see `endpoint` below.
 */
const INSTAGRAM_GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly isTransient: boolean,
    /**
     * `error_user_msg`, when Graph sends one. It is the only field in a Graph
     * error written for a person to read, and it is the field most often
     * missing from the generic refusals — so it is preferred over `message`
     * where it exists rather than relied on.
     */
    readonly userMessage: string | null = null,
    /** `fbtrace_id` — what Meta support asks for first. */
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/**
 * Codes worth retrying. Everything else fails identically on every attempt, so
 * retrying only delays the agent finding out.
 *
 *   1, 2    unknown or temporary platform error
 *   4, 17   application or user request limit
 *   613     calls-per-second limit
 *   2016xx  Messenger send-API transient failures
 */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 613, 201600, 201601]);

/** Meta's own name for "this person can no longer be messaged". */
export const OUTSIDE_WINDOW_CODE = 10;
export const ACCESS_TOKEN_CODE = 190;

/**
 * An expired or revoked page token (190) is retried, unlike the other codes
 * outside `TRANSIENT_CODES`.
 *
 * Those describe the request — a recipient who cannot be messaged, a comment
 * already replied to — and are final because the same call will be rejected
 * forever. 190 describes the credential, and it stops being true as soon as the
 * token is rotated.
 *
 * Treating it as final silently discarded recoverable work: an attachment
 * download would give up on a customer's photo, and a reply would be marked
 * permanently failed, both while the only thing wrong was a token nobody had
 * replaced yet. Retrying lets the job exhaust its attempts into 'dead', where it
 * remains visible and replayable afterwards.
 */
const RETRYABLE_AFTER_HUMAN_FIX = new Set([ACCESS_TOKEN_CODE]);

function pageToken(): string {
  const token = env().META_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'META_PAGE_ACCESS_TOKEN is not configured — Facebook and Instagram cannot send',
    );
  }
  return token;
}

/**
 * The host and credential to address a platform with.
 *
 * An Instagram professional account connected through **Instagram Login** is not
 * reachable with the Page token at all, and not on `graph.facebook.com` either:
 * it has its own access token and is served from `graph.instagram.com`. The
 * paths are identical, which is the only reason this is a two-field return
 * rather than a second client.
 *
 * Keyed on whether `INSTAGRAM_ACCESS_TOKEN` is set rather than on a mode flag,
 * because the token is the thing that actually decides it: a deployment holding
 * an Instagram token has no use for the Page token on Instagram, and one holding
 * only the Page token cannot use the Instagram host whatever a flag said. Unset
 * is the Page-connected account every deployment had before this existed.
 */
function endpoint(platform: MetaPlatform): { base: string; token: string } {
  const instagramToken = env().INSTAGRAM_ACCESS_TOKEN;

  if (platform === 'instagram' && instagramToken) {
    return { base: INSTAGRAM_GRAPH_BASE, token: instagramToken };
  }

  return { base: GRAPH_BASE, token: pageToken() };
}

/**
 * The account a reply goes out from, per platform, or null when none is set.
 *
 * Separate from `accountId` because the send path needs to *compare* this with
 * the account a message arrived on, and a comparison cannot be made out of an
 * exception: an unconfigured deployment and a misconfigured one call for
 * different sentences, and both are decided in `lib/meta/thread.ts`.
 */
export function configuredAccountId(platform: MetaPlatform): string | null {
  const e = env();
  return (platform === 'instagram' ? e.INSTAGRAM_ACCOUNT_ID : e.FACEBOOK_PAGE_ID) || null;
}

/** The account a reply goes out from, per platform. */
export function accountId(platform: MetaPlatform): string {
  const id = configuredAccountId(platform);
  if (!id) {
    throw new Error(
      platform === 'instagram'
        ? 'INSTAGRAM_ACCOUNT_ID is not configured'
        : 'FACEBOOK_PAGE_ID is not configured',
    );
  }
  return id;
}

export function isConfigured(platform: MetaPlatform): boolean {
  const e = env();
  // Either credential will do for Instagram: which one is held is what decides
  // the host and the token, and holding neither is what makes it unconfigured.
  const hasToken =
    platform === 'instagram'
      ? Boolean(e.INSTAGRAM_ACCESS_TOKEN || e.META_PAGE_ACCESS_TOKEN)
      : Boolean(e.META_PAGE_ACCESS_TOKEN);

  if (!hasToken) return false;
  return configuredAccountId(platform) !== null;
}

async function graph<T>(
  platform: MetaPlatform,
  path: string,
  init: {
    method: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    query?: Record<string, string>;
  },
): Promise<T> {
  const { base, token } = endpoint(platform);

  const url = new URL(`${base}/${path}`);
  url.searchParams.set('access_token', token);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    // A network failure is always worth retrying; it says nothing about whether
    // the request was valid.
    throw new MetaApiError(
      `Graph API unreachable: ${error instanceof Error ? error.message : String(error)}`,
      0,
      null,
      null,
      true,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Fall through: a non-JSON body from Graph is itself the error message.
  }

  if (!response.ok) {
    const body = parsed as {
      error?: {
        message?: string;
        code?: number;
        error_subcode?: number;
        error_user_msg?: string;
        fbtrace_id?: string;
      };
    };
    const code = body?.error?.code ?? null;

    // Logged whole, because Graph's generic refusals ("An unknown error has
    // occurred.") carry their only distinguishing detail in the fields around
    // the message.
    // The host is named as well as the path: an Instagram call can now go to
    // either origin depending on which credential is configured, and "wrong
    // host for this token" is refused with the same unhelpful sentence as
    // everything else Graph declines.
    console.warn(
      `[meta] ${platform} ${init.method} ${url.host}/${path} failed with ` +
        `${response.status}: ${text.slice(0, 1000)}`,
    );

    throw new MetaApiError(
      body?.error?.message ?? text.slice(0, 500) ?? `Graph API returned ${response.status}`,
      response.status,
      code,
      body?.error?.error_subcode ?? null,
      // 5xx is transient regardless of code: Meta returns them without one.
      (code !== null && (TRANSIENT_CODES.has(code) || RETRYABLE_AFTER_HUMAN_FIX.has(code))) ||
        response.status >= 500,
      body?.error?.error_user_msg ?? null,
      body?.error?.fbtrace_id ?? null,
    );
  }

  return parsed as T;
}

// --- Direct messages --------------------------------------------------------

export type SendMessageResult = { messageId: string | null; recipientId: string | null };

/**
 * Sends a direct message.
 *
 * `tag` is what keeps a reply legal outside the 24-hour window: HUMAN_AGENT
 * says a person is answering, which is the whole premise of this product, and
 * is valid for seven days. Sending without it outside the window is rejected
 * rather than queued.
 */
export async function sendDirectMessage(input: {
  platform: MetaPlatform;
  recipientId: string;
  text: string;
  tag: 'RESPONSE' | 'HUMAN_AGENT';
}): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    recipient: { id: input.recipientId },
    message: { text: input.text },
    messaging_type: input.tag === 'HUMAN_AGENT' ? 'MESSAGE_TAG' : 'RESPONSE',
  };

  if (input.tag === 'HUMAN_AGENT') body.tag = 'HUMAN_AGENT';

  const result = await graph<{ message_id?: string; recipient_id?: string }>(
    input.platform,
    `${accountId(input.platform)}/messages`,
    { method: 'POST', body },
  );

  return {
    messageId: result?.message_id ?? null,
    recipientId: result?.recipient_id ?? null,
  };
}

// --- Comments ---------------------------------------------------------------

/**
 * Issues one comment operation, in whichever shape the platform expects.
 *
 * The shape comes from `lib/meta/comments.ts`, which is where the two
 * platforms' disagreements are written down and tested. This function is only
 * the fetch and the id it reads back.
 */
async function comment<T>(
  platform: MetaPlatform,
  commentId: string,
  operation: CommentOperation,
): Promise<T> {
  const request = commentRequest({
    platform,
    commentId,
    // Resolved for every operation even though only Instagram's private reply
    // sends it, so a deployment missing the account id fails the same way on
    // every comment call rather than on one of the four.
    accountId: accountId(platform),
    operation,
  });

  return graph<T>(platform, request.path, {
    method: request.method,
    body: request.body,
    query: request.query,
  });
}

/**
 * Replies publicly, under the comment.
 *
 * The reply is visible to everyone who can see the post, which is the point:
 * one good public answer saves the next twenty people from asking.
 *
 * `commentId` must be the comment the reply belongs *under*, which on Instagram
 * is the root of the thread rather than whichever reply came last — see
 * `commentReplyTarget`.
 */
export async function replyToComment(input: {
  platform: MetaPlatform;
  commentId: string;
  message: string;
}): Promise<string | null> {
  const result = await comment<{ id?: string }>(input.platform, input.commentId, {
    kind: 'reply',
    message: input.message,
  });

  return result?.id ?? null;
}

/**
 * Takes a public comment into a private thread.
 *
 * Meta allows exactly one private reply per comment, ever, and only within
 * seven days — so this is the one send in the product that genuinely cannot be
 * retried. The caller records that it happened.
 *
 * Addressed to the comment the agent is answering rather than to the thread's
 * root: the seven days are counted from the comment named here, so naming the
 * newest one is what buys the most time.
 */
export async function privateReplyToComment(input: {
  platform: MetaPlatform;
  commentId: string;
  message: string;
}): Promise<string | null> {
  // Facebook answers with the new message's `id`, Instagram with `message_id`
  // and a `recipient_id` — it is the messages endpoint there, not a comment one.
  const result = await comment<{ id?: string; message_id?: string }>(
    input.platform,
    input.commentId,
    { kind: 'private_reply', message: input.message },
  );

  return result?.message_id ?? result?.id ?? null;
}

/**
 * Hides or unhides a comment.
 *
 * The usual answer to abuse, and reversible, which is why it is the one an agent
 * reaches for first: the words stay on the record for us and stop being visible
 * to everyone else. Its opposite — unhide — is the same call, so the two are one
 * function rather than two that could disagree about the parameter name.
 */
export async function setCommentHidden(input: {
  platform: MetaPlatform;
  commentId: string;
  hidden: boolean;
}): Promise<void> {
  await comment(input.platform, input.commentId, { kind: 'hide', hidden: input.hidden });
}

/**
 * Deletes a comment.
 *
 * Irreversible, and it removes a customer's words from a public thread, so the
 * console asks before calling it and records who asked. Both platforms allow it
 * on any comment on media the account owns, not only on the account's own
 * comments.
 */
export async function deleteComment(input: {
  platform: MetaPlatform;
  commentId: string;
}): Promise<void> {
  await comment(input.platform, input.commentId, { kind: 'delete' });
}

// --- Profiles ---------------------------------------------------------------

export type MetaProfile = {
  name: string | null;
  username: string | null;
  /**
   * Signed CDN link, and a short-lived one. Copy the bytes before storing
   * anything — see `contacts.avatarPath`.
   */
  pictureUrl: string | null;
};

/**
 * The fields the **Business Asset User Profile Access** feature grants, per
 * platform.
 *
 * Every one of them is gated behind that single feature and nothing else, which
 * is why they are requested together: a partial list would not lower the
 * approval bar, it would only leave the console with less to show. The three
 * fields Meta gates *separately* — `locale` (`pages_user_locale`), `timezone`
 * (`pages_user_timezone`) and `gender` (`pages_user_gender`) — are deliberately
 * absent. Asking for one we are not approved for fails the whole request, so
 * the name we do have rights to would be lost along with it.
 *
 * Instagram names the same idea with a different vocabulary: no first/last
 * split, and a `username` that is the handle an agent would actually recognise.
 */
export function profileFields(platform: MetaPlatform): string {
  return platform === 'instagram'
    ? 'name,username,profile_pic'
    : 'first_name,last_name,name,profile_pic';
}

type RawProfile = {
  name?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  profile_pic?: string;
};

/**
 * The display name out of whichever fields Graph actually answered with.
 *
 * `name` is not always there even when the feature is approved — a person can
 * have one of the two halves and not the other — so first+last is a fallback
 * rather than a redundant second copy. Separate from the request so it can be
 * tested against real response shapes without a fetch.
 */
export function profileDisplayName(result: RawProfile): string | null {
  const full = result.name?.trim();
  if (full) return full;

  const joined = [result.first_name, result.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');

  return joined || null;
}

/**
 * Looks up a customer's profile.
 *
 * Messenger and Instagram webhooks identify the sender by a scoped id and
 * nothing else — no name, no handle, unlike WhatsApp, which puts the profile
 * name in the payload. This call is the only way the console ever learns who
 * wrote in, which is what makes it worth an approval.
 *
 * It **throws** like every other call here rather than returning null on
 * failure. The version that swallowed everything could not tell "this app is
 * not approved for the feature" from "this customer has no name to give", and
 * those need opposite responses: the first is a dashboard problem that will
 * affect every customer until somebody fixes it, the second is normal and
 * final. `lib/meta/errors.ts` separates them and the job handler acts on the
 * distinction.
 */
export async function fetchProfile(platform: MetaPlatform, userId: string): Promise<MetaProfile> {
  const result = await graph<RawProfile>(platform, userId, {
    method: 'GET',
    query: { fields: profileFields(platform) },
  });

  return {
    name: profileDisplayName(result ?? {}),
    username: result?.username?.trim() || null,
    pictureUrl: result?.profile_pic || null,
  };
}

/**
 * A response bigger than the caller was willing to hold.
 *
 * Its own type rather than a `MetaApiError`, because it is not something Graph
 * said: nothing is wrong with the request and retrying it will produce the same
 * oversized body. Callers treat it as a final, non-transient refusal.
 */
export class MetaContentTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`response body exceeded ${limitBytes} bytes`);
    this.name = 'MetaContentTooLargeError';
  }
}

/**
 * Downloads an attachment Meta has given us a URL for.
 *
 * `maxBytes` is enforced **while reading**, not after. Checking the length of a
 * Buffer that has already been materialised is not a guard against anything —
 * the memory it exists to bound has been allocated by the time the check runs,
 * so a wrong or hostile URL costs the worker the whole body first and reports
 * "too large" afterwards. The declared `Content-Length` is rejected up front
 * where there is one, and the stream is aborted mid-read where there is not.
 */
export async function downloadAttachment(
  url: string,
  options: { maxBytes?: number } = {},
): Promise<{ content: Buffer; contentType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new MetaApiError(
      `attachment download failed with ${response.status}`,
      response.status,
      null,
      null,
      response.status >= 500 || response.status === 429,
    );
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const { maxBytes } = options;

  if (maxBytes === undefined) {
    return { content: Buffer.from(await response.arrayBuffer()), contentType };
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new MetaContentTooLargeError(maxBytes);
  }

  const reader = response.body?.getReader();
  // No body to stream — an empty response, or a runtime that did not give us
  // one. `arrayBuffer` is bounded by the header check above in that case.
  if (!reader) {
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > maxBytes) throw new MetaContentTooLargeError(maxBytes);
    return { content, contentType };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MetaContentTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  return { content: Buffer.concat(chunks), contentType };
}

// --- Thread control ---------------------------------------------------------

/*
  Conversation Routing, which is what Meta now calls the handover protocol.

  Every endpoint below is documented on `/{page-id}`. They are addressed here
  through `accountId(platform)` and routed through `graph(platform, …)` — the
  same node, host and token `sendDirectMessage` uses — because a control call
  aimed at a different account from the send it is meant to unblock would be
  worse than no button at all. Instagram in particular resolves to a different
  host when `INSTAGRAM_ACCESS_TOKEN` is set, and taking control on one host to
  send on another would silently do nothing useful.

  The PSID is page-scoped in exactly the same way the send is, which is why
  `lib/tickets/meta-thread.ts` resolves both from the one inbound row.

  Instagram routing is gated separately by Meta, behind the `ig_multi_app` flag
  on `GET /me?fields=messaging_feature_status`. Nothing here checks it: an
  account without it is refused by Graph with a message worth showing, and a
  pre-flight probe would add a round trip to every press to predict a refusal we
  are about to receive anyway.
*/

/** Meta's confirmation for every control write. It sends nothing else. */
type SuccessFlag = { success?: boolean };

/**
 * Who Graph says holds thread control, or null when it would not say.
 *
 * `recipient` is a bare id here, not the `{id: …}` object the send API and the
 * control writes take. That asymmetry is Meta's, not a slip.
 */
export async function fetchThreadOwner(
  platform: MetaPlatform,
  psid: string,
): Promise<ThreadOwnerReading> {
  const body = await graph<unknown>(platform, `${accountId(platform)}/thread_owner`, {
    method: 'GET',
    query: { recipient: psid },
  });

  return parseThreadOwner(body);
}

/**
 * Makes this app the thread owner.
 *
 * Allowed when the thread is idle or when this app is the page's primary
 * receiver. Otherwise Graph refuses — see `isNotThreadOwner` — and the caller's
 * fallback is `requestThreadControl`, which asks the current owner instead.
 */
export async function takeThreadControl(
  platform: MetaPlatform,
  psid: string,
  metadata?: string,
): Promise<void> {
  await controlCall(platform, 'take_thread_control', psid, metadata);
}

/**
 * Returns the thread to idle, where the page's default app answers.
 *
 * This rather than `pass_thread_control` at the default app's id: Meta
 * documents release as the way to hand a conversation back, and it needs no
 * knowledge of which app that is. Passing would require this deployment to hold
 * a copy of the page's default app id, which is configured in Page settings and
 * changes there without telling us.
 */
export async function releaseThreadControl(
  platform: MetaPlatform,
  psid: string,
  metadata?: string,
): Promise<void> {
  await controlCall(platform, 'release_thread_control', psid, metadata);
}

/**
 * Asks the current owner to hand the thread over.
 *
 * The polite route, and the only one open to an app that is not the primary
 * receiver. The owner receives a `request_thread_control` webhook and may
 * honour it or ignore it, so this returns having asked — never having got.
 */
export async function requestThreadControl(
  platform: MetaPlatform,
  psid: string,
  metadata?: string,
): Promise<void> {
  await controlCall(platform, 'request_thread_control', psid, metadata);
}

async function controlCall(
  platform: MetaPlatform,
  edge: string,
  psid: string,
  metadata: string | undefined,
): Promise<void> {
  const result = await graph<SuccessFlag>(platform, `${accountId(platform)}/${edge}`, {
    method: 'POST',
    body: { recipient: { id: psid }, ...(metadata ? { metadata } : {}) },
  });

  // Graph answers `{"success": true}` and signals failure with an HTTP error,
  // which `graph()` has already thrown by here. A 200 carrying `success: false`
  // is undocumented; treating it as success would report a handover that did
  // not happen, and every caller of this writes that claim to the database.
  if (result && result.success === false) {
    throw new MetaApiError(`${edge} returned success: false`, 200, null, null, false);
  }
}

/**
 * Graph's "you are not the thread owner" refusal.
 *
 * `100 / 2534037` — "The action is invalid since it's not the thread owner."
 * It is the documented answer to taking a thread this app is not the primary
 * receiver for, and the signal to fall back to asking the owner rather than
 * reporting a failure the agent can do nothing with.
 */
export const NOT_THREAD_OWNER_SUBCODE = 2534037;

export function isNotThreadOwner(error: unknown): boolean {
  return error instanceof MetaApiError && error.subcode === NOT_THREAD_OWNER_SUBCODE;
}
