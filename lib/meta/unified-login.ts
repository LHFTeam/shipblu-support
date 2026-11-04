import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appUrl, env, metaAppSecret } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { escapeHtml } from '@/lib/email/html';
import { isTimeout } from '@/lib/http/deadline';
import { requiredScopes } from '@/lib/meta/capabilities';
import { readGraph, type TokenInspection } from '@/lib/meta/debug-token';
import { GRAPH_BASE, GRAPH_VERSION, graphTimeout } from '@/lib/meta/graph';

/**
 * Connecting the Instagram account through Meta's Instagram API with Unified
 * Login: the login dialog, the code exchange, and the page that hands the
 * resulting token to the admin who signed in.
 *
 * Unified Login is the third `MetaConnection` (`./connection.ts` has the table).
 * Its credential is a Business Integration System User token — what Meta's
 * dashboard calls a "System-user access token (SUAT)", minted by Facebook Login
 * for Business for the business portfolio the admin picks in the dialog, and
 * configured never to expire. It is obtained with the authorization code grant
 * and nothing else: the dialog is opened with the configuration's `config_id`
 * in place of `scope` and `response_type=code`, the code comes back to
 * `CALLBACK_PATH`, and the server exchanges it with the app secret.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication
 * https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 *
 * **The token is shown to the admin's browser once and stored nowhere.** That
 * is the design and not a shortcut. This repo stores exactly one credential,
 * the WhatsApp business token, sealed under a key the database never sees, and
 * AGENTS.md says a second table holding a secret is a second place to look and
 * its own change with its own argument. This token does not earn one: it is
 * one per environment, it never expires, and `INSTAGRAM_UNIFIED_LOGIN_TOKEN`
 * in the environment group is where every Instagram call already reads it
 * from (`metaConnection`). Meta's own dashboard hands a system-user token to
 * an admin's browser the same way — "Generate token", shown once — so the
 * page is the dashboard's step with the exchange done by the server that
 * holds the app secret. What keeps a one-time page acceptable:
 *
 * - Only an agent holding `admin.channels.connect` can open the dialog or
 *   receive the callback; a cookie-less request never reaches either route
 *   (`proxy.ts`), and a request whose session is gone is answered 401.
 * - The `state` Meta echoes back is bound to the browser that opened the
 *   dialog by a cookie scoped to these two routes, compared in constant time,
 *   and cleared on the first callback. A callback carrying somebody else's
 *   code, or a replayed one, meets no matching cookie.
 * - The code is single-use and short-lived, and the exchange needs the app
 *   secret, so a code that leaks from a URL buys nothing on its own.
 * - The page is answered `Cache-Control: no-store` and
 *   `Referrer-Policy: no-referrer`, the token appears only inside a
 *   `<textarea>` — never in a URL, an attribute or a log line — and every
 *   sentence that repeats what Meta or the network said has the code and the
 *   app secret cut out of it (`redact`).
 *
 * `/me` with this token is the business integration system user, not the
 * Instagram account: the account every call is addressed to is
 * `INSTAGRAM_ACCOUNT_ID`, and `/me/assigned_instagram_accounts` is how the
 * page proves the token reaches it.
 */

export const START_PATH = '/api/meta/unified-login/start';
export const CALLBACK_PATH = '/api/meta/unified-login/callback';

/**
 * The cookie that binds the dialog's `state` to the browser that opened it.
 *
 * `Path` is the two routes' common prefix, so the cookie rides on nothing else
 * the console does. `SameSite=Lax` and not `Strict`: the callback is a
 * top-level navigation arriving from facebook.com, which Lax sends the cookie
 * on and Strict would not, leaving every callback "not opened from the
 * console". Ten minutes is longer than anybody takes in Meta's dialog and
 * shorter than a forgotten tab.
 */
export const STATE_COOKIE = 'ig_unified_login_state';
const STATE_COOKIE_PATH = '/api/meta/unified-login';
const STATE_MAX_AGE_SECONDS = 600;

export type MissingSetting = { variable: string; why: string };

export type Readiness =
  | { ready: true; appId: string; configId: string; redirectUri: string }
  | { ready: false; missing: MissingSetting[] };

/**
 * Whether this environment can open Meta's login for Unified Login, and if
 * not, which variables are missing — all of them at once, as
 * `coexistenceReadiness` reports, so whoever opens Render fixes the lot in one
 * visit rather than one per deploy.
 */
export function unifiedLoginReadiness(): Readiness {
  const e = env();
  const missing: MissingSetting[] = [];

  if (!e.META_APP_ID) {
    missing.push({
      variable: 'META_APP_ID',
      why: "Meta's login is opened for this app, and the code it returns is exchanged as it.",
    });
  }
  if (!metaAppSecret()) {
    missing.push({
      variable: 'META_APP_SECRET',
      why: 'The code Meta returns is exchanged for the system-user token with the app secret.',
    });
  }
  if (!e.INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID) {
    missing.push({
      variable: 'INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID',
      // What the id must name: the configuration decides the token type and
      // the permissions, and nothing here can check either afterwards.
      why:
        'The Facebook Login for Business configuration from the "API setup with Unified ' +
        'login" tab — login variation General, access token System-user, expiration Never, ' +
        'Instagram account required — whose config_id the login dialog is opened with.',
    });
  }
  if (!e.APP_URL) {
    missing.push({
      variable: 'APP_URL',
      why: `Meta sends the code back to ${CALLBACK_PATH} on this address, which must be registered as the configuration's redirect URL.`,
    });
  }

  if (missing.length > 0) return { ready: false, missing };
  return {
    ready: true,
    appId: e.META_APP_ID!,
    configId: e.INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID!,
    redirectUri: new URL(CALLBACK_PATH, appUrl()).toString(),
  };
}

/** Meta's ids for apps and configurations are numeric strings. */
const META_ID = /^\d{5,20}$/;

function id(value: string, what: string): string {
  if (!META_ID.test(value)) throw new Error(`${what} must be a numeric Meta id`);
  return value;
}

/**
 * The login dialog Meta's manual flow documents, for a Facebook Login for
 * Business configuration: `https://www.facebook.com/{version}/dialog/oauth`.
 *
 * `config_id` in place of `scope` — the configuration carries the permissions
 * and the token type, and a `scope` beside it is refused. `response_type=code`
 * because a system-user token is only minted on the authorization code grant;
 * the implicit flow answers with a user token. `override_default_response_type`
 * is documented for the JS SDK's `FB.login`, where a configuration's default
 * would otherwise win over the response type asked for; the dialog ignores it
 * when the two agree, so it is sent for the one case they might not.
 * `prompt=login`, which shows both login options to somebody already signed
 * into Facebook, is left out: the admin connecting this account is signed in
 * as themselves, and a second prompt is a second place to pick the wrong
 * identity. The ids are checked here because the URL is built from them.
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 * https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/
 */
export function loginDialogUrl(input: {
  appId: string;
  configId: string;
  redirectUri: string;
  state: string;
}): URL {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', id(input.appId, 'the app id'));
  url.searchParams.set('config_id', id(input.configId, 'the configuration id'));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('state', input.state);
  return url;
}

/**
 * The code exchange: `GET /oauth/access_token` with `client_id`,
 * `client_secret`, `redirect_uri` and `code` as query parameters — the Meta
 * app's id and secret, never an Instagram app's, because the dialog was
 * opened as the Meta app. `redirect_uri` must be byte-for-byte the one the
 * dialog was opened with, or Meta refuses the code.
 *
 * GET and a query string because that is the only shape Meta documents, which
 * puts the app secret and the code in a URL. So this builds the URL and
 * nothing else; `exchangeCode` sends it with a `fetch` of its own, outside
 * every Graph client in this repo (which put the request into their error
 * messages), and names the request by host and path in anything it says. The
 * same holds for a tracer: a fetch tracing span records the URL whole, and
 * whoever adds an `instrumentation.ts` keeps the Graph hosts' query strings
 * out of every span in the same change (`docs/PROJECT-STATE.md` §6.88).
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 */
export function tokenExchangeUrl(input: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
}): URL {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('client_id', id(input.appId, 'the app id'));
  url.searchParams.set('client_secret', input.appSecret);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code', input.code);
  return url;
}

/** 32 random bytes as base64url: 43 characters, URL- and cookie-safe as they are. */
export function newState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Whether the `state` Meta echoed back is the one the cookie holds. Constant
 * time over equal lengths; unequal lengths are a mismatch without a comparison,
 * since `timingSafeEqual` throws on them, and the length of a forged value is
 * not a secret.
 */
export function sameState(expected: string | null, returned: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(returned);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether the state cookie carries `Secure`: dropped only for an http
 * `APP_URL`, which is a laptop. A browser refuses to store a Secure cookie set
 * over http, and the callback would then always read as not opened from the
 * console. Unset counts as https, so a misconfigured environment errs towards
 * the stricter cookie.
 */
export function stateCookieSecure(): boolean {
  return !env().APP_URL?.startsWith('http://');
}

/** The `Set-Cookie` value that stores the state for the callback. */
export function stateCookie(state: string, secure: boolean): string {
  return cookieHeader(state, STATE_MAX_AGE_SECONDS, secure);
}

/** The `Set-Cookie` value that removes the state cookie, on every callback. */
export function clearedStateCookie(secure: boolean): string {
  return cookieHeader('', 0, secure);
}

function cookieHeader(value: string, maxAge: number, secure: boolean): string {
  const attributes = [
    `${STATE_COOKIE}=${value}`,
    `Path=${STATE_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * The state cookie's value out of a request's `Cookie` header, or null. A
 * hand-written reader rather than `next/headers`, so the route reads the
 * request it was handed and a test can hand it one.
 */
export function readStateCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === STATE_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export type CallbackParams =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'invalid'; reason: string };

/**
 * What Meta's redirect carried. A successful dialog answers `code` and `state`;
 * a cancelled one `error=access_denied` with `error_reason` and
 * `error_description`; anything else is a URL somebody typed.
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 */
export function readCallbackParams(searchParams: URLSearchParams): CallbackParams {
  const error = searchParams.get('error');
  if (error) {
    const description = searchParams.get('error_description') ?? searchParams.get('error_reason');
    return {
      kind: 'cancelled',
      reason: description ? `${error}: ${description}` : error,
    };
  }
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  if (!code) return { kind: 'invalid', reason: 'Meta sent back no code' };
  if (!state) return { kind: 'invalid', reason: 'Meta sent back no state' };
  return { kind: 'code', code, state };
}

/**
 * `text` with every occurrence of each secret cut out. No minimum length,
 * unlike `redact` in `./debug-token.ts`: every secret this is handed was sent
 * to Meta by this module or the callback, and a short one is still one.
 */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (out, secret) => (secret ? out.split(secret).join('[redacted]') : out),
    text,
  );
}

export type Exchange =
  { ok: true; token: string; expiresIn: number | null } | { ok: false; error: string };

/**
 * `GET /oauth/access_token`, sent with a `fetch` of its own — `tokenExchangeUrl`
 * says why — answered `{ access_token, token_type, expires_in }`, where
 * `expires_in` is absent for a token configured never to expire. Every
 * sentence names host and path, and anything Meta or the network layer says
 * back has the code and the app secret cut out before it is repeated.
 */
export async function exchangeCode(input: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
}): Promise<Exchange> {
  const url = tokenExchangeUrl(input);
  const where = `${url.host}${url.pathname}`;
  const scrub = (text: string) => redact(text, [input.appSecret, input.code]);
  const timeoutMs = graphTimeout('GET');

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      error: isTimeout(error)
        ? `${where} did not answer in ${timeoutMs / 1000}s. Nothing was changed; connect again.`
        : `${where} could not be reached (${scrub(errorMessage(error))}). Nothing was changed; connect again.`,
    };
  }

  type ExchangeBody = {
    access_token?: unknown;
    expires_in?: unknown;
    error?: { message?: unknown };
  };
  let body: ExchangeBody | null = null;
  try {
    body = JSON.parse(text) as ExchangeBody;
  } catch {
    // Not JSON: refused below with the status.
  }

  if (response.ok && typeof body?.access_token === 'string' && body.access_token) {
    return {
      ok: true,
      token: body.access_token,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : null,
    };
  }

  const said =
    typeof body?.error?.message === 'string'
      ? scrub(body.error.message)
      : `HTTP ${response.status}`;
  return {
    ok: false,
    error:
      `Meta refused the login code (${said}). The code is used once and lives only minutes, ` +
      `and the redirect URL registered on the configuration must be exactly this site's ` +
      `${CALLBACK_PATH}. Nothing was changed; connect again.`,
  };
}

export type ConnectedAccount = { id: string; username: string | null };

/**
 * The Instagram professional accounts the token reaches:
 * `GET /me/assigned_instagram_accounts?fields=id,username`, bearer token, on
 * `graph.facebook.com`. `/me` here is the business integration system user,
 * which is why the accounts are an edge on it rather than the answer itself.
 * Throws when Meta did not answer or refused, with Meta's sentence.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
 */
export async function connectedAccounts(token: string): Promise<ConnectedAccount[]> {
  const url = new URL(`${GRAPH_BASE}/me/assigned_instagram_accounts`);
  url.searchParams.set('fields', 'id,username');
  type Body = { data?: { id?: unknown; username?: unknown }[]; error?: { message?: unknown } };
  const { ok, status, body } = await readGraph<Body>(url, token);
  if (!ok || !Array.isArray(body?.data)) {
    throw new Error(graphRefusal(url, status, body?.error));
  }
  return body.data
    .filter((entry): entry is { id: string; username?: unknown } => typeof entry.id === 'string')
    .map((entry) => ({
      id: entry.id,
      username: typeof entry.username === 'string' ? entry.username : null,
    }));
}

/**
 * The business portfolio the token was minted for:
 * `GET /me?fields=client_business_id`, Facebook Login for Business's own way
 * of naming the client's business. Metadata the page prints; null when Meta
 * did not say, and the caller decides whether that is worth a warning.
 */
export async function clientBusinessId(token: string): Promise<string | null> {
  const url = new URL(`${GRAPH_BASE}/me`);
  url.searchParams.set('fields', 'client_business_id');
  type Body = { client_business_id?: unknown; error?: { message?: unknown } };
  const { ok, status, body } = await readGraph<Body>(url, token);
  if (!ok) throw new Error(graphRefusal(url, status, body?.error));
  return typeof body?.client_business_id === 'string' ? body.client_business_id : null;
}

function graphRefusal(url: URL, status: number, error: { message?: unknown } | undefined) {
  const said = typeof error?.message === 'string' ? error.message : `HTTP ${status}`;
  return `${url.host}${url.pathname} refused the token: ${said}`;
}

/**
 * Why a token Meta just issued must not be used, or null. Only what Meta
 * actually said is held against it: not valid, or minted for another app —
 * which is a configuration belonging to a different app than `META_APP_ID`
 * names, since the dialog was opened with both.
 */
export function refuseInspection(inspection: TokenInspection, appId: string): string | null {
  if (!inspection.isValid) {
    return `Meta says this token is not valid${inspection.error ? `: ${inspection.error}` : ''}.`;
  }
  if (inspection.appId && inspection.appId !== appId) {
    return (
      `Meta minted this token for app ${inspection.appId}, and this environment is app ` +
      `${appId}. Check that INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID belongs to the app META_APP_ID names.`
    );
  }
  return null;
}

/**
 * A doubt about the token that is not a refusal: a type other than
 * `SYSTEM_USER`. What `debug_token` reports as the type of a Business
 * Integration System User token has not been observed yet, so the page says
 * what it was and lets the admin decide, where a refusal would turn the first
 * real connection away on a guess.
 */
export function inspectionWarning(inspection: TokenInspection): string | null {
  if (inspection.type === 'SYSTEM_USER') return null;
  return (
    `Meta reports the token's type as ${inspection.type ?? 'nothing'}, not SYSTEM_USER. A ` +
    `system-user token is what the configuration should mint; if this one expires, the ` +
    `configuration's access token setting is not "System-user access token".`
  );
}

export type CallbackOutcome =
  | {
      kind: 'connected';
      token: string;
      accounts: ConnectedAccount[];
      /** Null when `debug_token` did not answer; the warnings say so. */
      inspection: TokenInspection | null;
      clientBusinessId: string | null;
      warnings: string[];
      /** `INSTAGRAM_ACCOUNT_ID` as this environment holds it. */
      configuredAccountId: string | null;
    }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'refused'; reason: string };

/**
 * The one-time page, as an HTML string.
 *
 * The token appears exactly once, as the text of a `readonly` textarea — not
 * in an attribute, not in a URL, not in the copy button's script, which reads
 * it from the textarea. Every interpolated value is escaped. Plain inline
 * CSS in the console's light palette: this page is served by a route handler
 * and has no stylesheet, and one dark variant here would be the one the
 * `light-only` rule exists to refuse.
 */
export function callbackPage(outcome: CallbackOutcome): string {
  const body =
    outcome.kind === 'connected'
      ? connectedBody(outcome)
      : outcome.kind === 'cancelled'
        ? `<h1>Nothing was changed</h1>
<p>Meta's login was closed before it finished (${escapeHtml(outcome.reason)}). No token was issued and nothing here moved.</p>`
        : `<h1>Instagram was not connected</h1>
<p>${escapeHtml(outcome.reason)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Instagram — Unified Login</title>
<style>
:root { color-scheme: light; }
body { margin: 0; padding: 24px 16px; background: #f6f7f9; color: #1c1f24; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 12px; }
h2 { font-size: 15px; margin: 20px 0 6px; }
p, li { margin: 0 0 8px; }
ul { padding-inline-start: 20px; margin: 0 0 8px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f0f2f5; padding: 1px 4px; border-radius: 4px; }
textarea { width: 100%; box-sizing: border-box; min-height: 120px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 8px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff; color: #1c1f24; }
button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #1a5fd0; background: #1a5fd0; color: #fff; cursor: pointer; }
.warning { border-inline-start: 3px solid #d97706; background: #fff7ed; padding: 8px 12px; border-radius: 6px; }
.danger { border-inline-start: 3px solid #dc2626; background: #fef2f2; padding: 8px 12px; border-radius: 6px; }
.muted { color: #5b6470; }
a { color: #1a5fd0; }
</style>
</head>
<body>
<main>
${body}
<p><a href="/admin/channels">Back to Channels</a></p>
</main>
</body>
</html>
`;
}

function connectedBody(outcome: Extract<CallbackOutcome, { kind: 'connected' }>): string {
  const { accounts, inspection, configuredAccountId } = outcome;
  const reaches = configuredAccountId
    ? accounts.some((account) => account.id === configuredAccountId)
    : false;

  const accountItems = accounts
    .map(
      (account) =>
        `<li>${account.username ? `<strong>@${escapeHtml(account.username)}</strong> · ` : ''}<code>${escapeHtml(account.id)}</code>${
          account.id === configuredAccountId ? ' — the account this environment replies as' : ''
        }</li>`,
    )
    .join('\n');

  const accountWarning = !configuredAccountId
    ? `<p class="danger"><code>INSTAGRAM_ACCOUNT_ID</code> is not set in this environment. Every Instagram reply is addressed to the account it names, so set it to the account above that the team answers from before this token is of any use.</p>`
    : !reaches
      ? `<p class="danger">Every Instagram reply is addressed to <code>INSTAGRAM_ACCOUNT_ID</code> (<code>${escapeHtml(configuredAccountId)}</code>), and this token cannot address it: it is not among the accounts above. Connect again and share that account in Meta's dialog, or sign in as an admin of the portfolio that owns it.</p>`
      : '';

  const required = requiredScopes('unified_login');
  const missingScopes = inspection
    ? required.filter((scope) => !inspection.scopes.includes(scope))
    : [];
  const inspectionSection = inspection
    ? `<h2>What Meta says about the token</h2>
<ul>
<li>Type: <code>${escapeHtml(inspection.type ?? 'not reported')}</code></li>
<li>Expires: ${inspection.expiresAt ? escapeHtml(inspection.expiresAt.toISOString()) : 'never'}</li>
<li>Permissions: ${
        inspection.scopes.length
          ? inspection.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(', ')
          : 'none reported'
      }</li>
</ul>
${
  missingScopes.length
    ? `<p class="warning">Missing from the token, and needed: ${missingScopes
        .map((scope) => `<code>${escapeHtml(scope)}</code>`)
        .join(
          ', ',
        )}. Add them to the configuration's permissions in the "API setup with Unified login" tab and connect again.</p>`
    : ''
}`
    : `<p class="warning">Meta's token inspection did not answer, so the type, expiry and permissions are not shown. <code>npm run job -- check_meta_permissions</code> reads them once the token is set.</p>`;

  const warnings = outcome.warnings
    .map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`)
    .join('\n');

  return `<h1>Instagram connected through Unified Login</h1>
<p>Meta issued a system-user token for this app. It is shown here once and is stored nowhere; close this page and it is gone.</p>
<h2>Accounts the token reaches</h2>
<ul>
${accountItems}
</ul>
${accountWarning}
${inspectionSection}
<p>Business portfolio: ${
    outcome.clientBusinessId
      ? `<code>${escapeHtml(outcome.clientBusinessId)}</code>`
      : '<span class="muted">not reported</span>'
  }</p>
${warnings}
<h2>The token</h2>
<textarea id="token" readonly>${escapeHtml(outcome.token)}</textarea>
<p><button type="button" id="copy">Copy token</button> <span id="copied" class="muted"></span></p>
<h2>What to do with it</h2>
<ol>
<li>On Render, set <code>INSTAGRAM_UNIFIED_LOGIN_TOKEN</code> to it in the <code>shipblu-support-production</code> environment group (<code>shipblu-support-staging</code> on staging). An environment group change redeploys every service that links it.</li>
<li>Once the deploy is live, run <code>npm run job -- subscribe_meta_webhooks object=instagram</code> so the account's webhooks are subscribed through this connection.</li>
<li>Then <code>npm run job -- check_meta_permissions</code>, which inspects the token the services actually hold.</li>
</ol>
<p class="muted">From the moment the token is set, every Instagram reply, profile read and comment action goes out over graph.facebook.com with it, ahead of the direct connection and the Page. <code>plans/instagram-unified-login.md</code> has the order for retiring the direct connection; the Page stays, as the fallback.</p>
<script>
document.getElementById('copy').addEventListener('click', function () {
  var token = document.getElementById('token').value;
  var note = document.getElementById('copied');
  navigator.clipboard.writeText(token).then(function () {
    note.textContent = 'Copied.';
  }, function () {
    note.textContent = 'Copy failed — select the text and copy it yourself.';
  });
});
</script>`;
}
