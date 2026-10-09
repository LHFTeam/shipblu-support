import { env, metaAppSecret } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { isTimeout } from '@/lib/http/deadline';
import { GRAPH_BASE, graphTimeout } from '@/lib/meta/graph';

/**
 * Asking Meta what a token is: `GET /debug_token`.
 *
 * One function, used by every caller that needs the answer —
 * `check_meta_permissions`, which prints it, and the WhatsApp credential code,
 * which stores what it says beside a sealed token. Two private copies would be
 * the `profile-refresh.ts` lesson over again: the job and the console asking
 * the same question and answering differently for the same token.
 *
 * `debug_token` rather than `/me/permissions`: the latter needs a *user* token,
 * and this deployment sends with Page and business tokens, where `/me` is not
 * the person and the edge does not exist. `debug_token` takes any token and is
 * authorised with the app token — the app id and the app secret joined by a
 * pipe — which goes in the Authorization header, because a URL is the part of a
 * request that reaches logs.
 *
 * **The inspected token cannot go in the header too.** `input_token` is a query
 * parameter and the endpoint has no other shape, so every sentence this module
 * builds names `host + pathname` and never the URL, and anything an error
 * carries back from the network layer has the token cut out of it before it is
 * repeated.
 *
 * A sentence is not the only place a URL goes. Every fetch tracing span
 * records it whole, as the span's name and as `http.url` / `url.full` — Next's
 * patched `fetch` on the web service, `@vercel/otel`'s fetch instrumentation,
 * OpenTelemetry's undici instrumentation. Nothing registers a tracer today (no
 * `instrumentation.ts`), so those spans go nowhere; whoever adds one keeps the
 * Graph hosts' query strings out of them, or this token is exported on every
 * call. `docs/PROJECT-STATE.md` §6.88 says how, and why
 * `NEXT_OTEL_FETCH_DISABLED` is not the answer.
 */

/** What `debug_token` answers, as Meta spells it. */
type DebugTokenData = {
  type?: string;
  app_id?: string;
  is_valid?: boolean;
  issued_at?: number;
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  granular_scopes?: { scope: string; target_ids?: string[] }[];
  error?: { message?: string; code?: number; subcode?: number };
};

/** What Meta said about a token, in this codebase's shapes. */
export type TokenInspection = {
  /** `PAGE`, `SYSTEM_USER`, `USER`, … — the answer §6.28 turned on. */
  type: string | null;
  appId: string | null;
  isValid: boolean;
  issuedAt: Date | null;
  /** Null for Meta's `expires_at: 0`, which means it never expires. */
  expiresAt: Date | null;
  /** When the token's access to people's data lapses; null for `0` or absent. */
  dataAccessExpiresAt: Date | null;
  scopes: string[];
  /**
   * Per permission, which assets it was granted for. Null targets mean "every
   * asset", which is how Meta reports a scope it does not narrow — and why a
   * caller checking a WABA must treat null as "not narrowed", not as "none".
   */
  granularScopes: { scope: string; targetIds: string[] | null }[];
  /** Meta's sentence when `isValid` is false — "Session has expired on …". */
  error: string | null;
};

/** Seconds since the epoch, with Meta's `0` meaning "never" or "not given". */
function instant(seconds: number | undefined): Date | null {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null;
}

function normalise(data: DebugTokenData): TokenInspection {
  return {
    type: data.type ?? null,
    appId: data.app_id ?? null,
    isValid: data.is_valid === true,
    issuedAt: instant(data.issued_at),
    expiresAt: instant(data.expires_at),
    dataAccessExpiresAt: instant(data.data_access_expires_at),
    scopes: data.scopes ?? [],
    granularScopes: (data.granular_scopes ?? []).map((entry) => ({
      scope: entry.scope,
      targetIds: entry.target_ids?.length ? entry.target_ids : null,
    })),
    error: data.error?.message ?? null,
  };
}

/**
 * What Meta says about `inputToken`.
 *
 * Throws when Meta could not be asked — the app credentials are missing, the
 * call did not answer, or it answered without a `data` object. A token Meta
 * *was* asked about and rejected is an answer, not a failure: it comes back with
 * `isValid: false` and Meta's sentence in `error`.
 */
export async function inspectToken(inputToken: string): Promise<TokenInspection> {
  const appId = env().META_APP_ID;
  const appSecret = metaAppSecret();

  if (!appId || !appSecret) {
    const missing = [!appId && 'META_APP_ID', !appSecret && 'META_APP_SECRET'].filter(Boolean);
    throw new Error(`${missing.join(', ')} must be set before a token can be inspected`);
  }

  const url = new URL(`${GRAPH_BASE}/debug_token`);
  url.searchParams.set('input_token', inputToken);

  let answer: {
    ok: boolean;
    status: number;
    body: { data?: DebugTokenData; error?: unknown } | null;
  };
  try {
    answer = await readGraph(url, `${appId}|${appSecret}`);
  } catch (error) {
    // Re-said rather than rethrown: the network layer's own message is not
    // ours to vouch for, and the one thing that must not survive into it is
    // the token riding in the query string.
    throw new Error(redact(errorMessage(error), inputToken));
  }

  const { ok, status, body } = answer;
  if (!ok || !body?.data) {
    throw new Error(
      redact(
        `debug_token failed (HTTP ${status}): ${JSON.stringify(body?.error ?? body)}`,
        inputToken,
      ),
    );
  }

  return normalise(body.data);
}

/**
 * `text` with every occurrence of `secret` cut out.
 *
 * Not for a value too short to be a credential: a Meta token runs to well over
 * a hundred characters, and cutting a five-letter test value out of a sentence
 * turns "debug_token failed" into nonsense without protecting anything.
 */
function redact(text: string, secret: string): string {
  return secret.length >= 16 ? text.split(secret).join('[redacted]') : text;
}

/**
 * A GET to Graph with the read deadline, and the JSON it answered with.
 *
 * The body is read as text and parsed separately because the two failures mean
 * opposite things here. A body that is not JSON is an answer — Meta's edge
 * sometimes serves an HTML page — and is reported as one, with the status. A
 * body that never arrived is not, and swallowing it into the same null reported
 * a working token as refused with HTTP 200: `check_meta_permissions` exists to
 * print what is true, and that sentence sends somebody to rotate a credential.
 *
 * Shared with that job's Instagram check, which asks a different host the same
 * kind of question.
 */
export async function readGraph<T>(
  url: URL,
  token: string,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  const timeoutMs = graphTimeout('GET');
  let response: Response;
  let text: string;
  try {
    // Header rather than query string: a URL is the part of a request that ends
    // up in logs, and every token read here is a live credential.
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    if (isTimeout(error)) {
      throw new Error(`${url.host}${url.pathname} did not answer in ${timeoutMs / 1000}s`);
    }
    // The cause, because a bare "fetch failed" is undici's whole message and
    // the reason — a DNS failure, a refused connection — is only on the cause.
    const cause =
      error instanceof Error && error.cause !== undefined ? ` (${errorMessage(error.cause)})` : '';
    throw new Error(
      `${url.host}${url.pathname} could not be reached: ${errorMessage(error)}${cause}`,
    );
  }

  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    // Not JSON: left null, and the caller reports the status it came with.
  }
  return { ok: response.ok, status: response.status, body };
}
