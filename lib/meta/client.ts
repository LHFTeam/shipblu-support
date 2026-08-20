import { env } from '@/lib/env';
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

/** The account a reply goes out from, per platform. */
export function accountId(platform: MetaPlatform): string {
  const e = env();
  const id = platform === 'instagram' ? e.INSTAGRAM_ACCOUNT_ID : e.FACEBOOK_PAGE_ID;
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
  if (!e.META_PAGE_ACCESS_TOKEN) return false;
  return Boolean(platform === 'instagram' ? e.INSTAGRAM_ACCOUNT_ID : e.FACEBOOK_PAGE_ID);
}

async function graph<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  url.searchParams.set('access_token', pageToken());
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
    console.warn(
      `[meta] ${init.method} ${path} failed with ${response.status}: ${text.slice(0, 1000)}`,
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
 * Replies publicly, under the comment.
 *
 * The reply is visible to everyone who can see the post, which is the point:
 * one good public answer saves the next twenty people from asking.
 */
export async function replyToComment(commentId: string, message: string): Promise<string | null> {
  const result = await graph<{ id?: string }>(`${commentId}/comments`, {
    method: 'POST',
    body: { message },
  });

  return result?.id ?? null;
}

/**
 * Takes a public comment into a private thread.
 *
 * Meta allows exactly one private reply per comment, ever, and only within
 * seven days — so this is the one send in the product that genuinely cannot be
 * retried. The caller records that it happened.
 */
export async function privateReplyToComment(
  commentId: string,
  message: string,
): Promise<string | null> {
  const result = await graph<{ id?: string }>(`${commentId}/private_replies`, {
    method: 'POST',
    body: { message },
  });

  return result?.id ?? null;
}

/** Hides a comment rather than deleting it — the usual answer to abuse. */
export async function hideComment(commentId: string, hidden = true): Promise<void> {
  await graph(`${commentId}`, { method: 'POST', body: { is_hidden: hidden } });
}

// --- Profiles ---------------------------------------------------------------

export type MetaProfile = { name: string | null; username: string | null };

/**
 * Looks up a customer's display name.
 *
 * Best-effort by design: the profile API needs permissions a new app often
 * lacks, and a ticket from "Facebook user 4821…" is far better than no ticket.
 */
export async function fetchProfile(
  platform: MetaPlatform,
  userId: string,
): Promise<MetaProfile | null> {
  try {
    const fields = platform === 'instagram' ? 'name,username' : 'first_name,last_name,name';
    const result = await graph<{
      name?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    }>(userId, { method: 'GET', query: { fields } });

    const name =
      result?.name ??
      [result?.first_name, result?.last_name].filter(Boolean).join(' ').trim() ??
      null;

    return { name: name || null, username: result?.username ?? null };
  } catch (error) {
    console.warn(`[meta] could not fetch the profile for ${userId}`, error);
    return null;
  }
}

/** Downloads an attachment Meta has given us a URL for. */
export async function downloadAttachment(
  url: string,
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

  return {
    content: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}
