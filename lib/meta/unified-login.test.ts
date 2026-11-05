import { describe, expect, it } from 'vitest';
import type { TokenInspection } from '@/lib/meta/debug-token';
import { GRAPH_VERSION } from '@/lib/meta/graph';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import {
  CALLBACK_PATH,
  callbackPage,
  clearedStateCookie,
  inspectionWarning,
  loginDialogUrl,
  newState,
  readCallbackParams,
  readStateCookie,
  refuseInspection,
  sameState,
  STATE_COOKIE,
  stateCookie,
  tokenExchangeUrl,
  unifiedLoginReadiness,
} from './unified-login';

/**
 * The pure half of the Unified Login flow: the two URLs, asserted against
 * Meta's manual-flow reference rather than against each other; the cookie
 * that binds the callback to the browser; and the one-time page, whose
 * contract is that the token appears once, as text, and nowhere else.
 */

const APP_ID = '1234567890123456';
const CONFIG_ID = '9876543210987654';
const REDIRECT = 'https://support.example.com/api/meta/unified-login/callback';
const TOKEN = 'EAAUnifiedLoginTokenThatIsLongEnoughToBeRealistic1234567890';

function inspection(overrides: Partial<TokenInspection> = {}): TokenInspection {
  return {
    type: 'SYSTEM_USER',
    appId: APP_ID,
    isValid: true,
    issuedAt: null,
    expiresAt: null,
    dataAccessExpiresAt: null,
    // The seven the live token carries, less the three pages_* ones: no
    // business_management, which the configuration never puts on it.
    scopes: ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'],
    granularScopes: [],
    error: null,
    ...overrides,
  };
}

describe('loginDialogUrl', () => {
  it('opens Meta’s dialog with the configuration in place of a scope', () => {
    const url = loginDialogUrl({
      appId: APP_ID,
      configId: CONFIG_ID,
      redirectUri: REDIRECT,
      state: 'abc',
    });

    expect(url.host).toBe('www.facebook.com');
    expect(url.pathname).toBe(`/${GRAPH_VERSION}/dialog/oauth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      config_id: CONFIG_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      override_default_response_type: 'true',
      state: 'abc',
    });
    // `scope` and `config_id` are refused together, and `prompt=login` is a
    // choice the plan leaves to the admin.
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('prompt')).toBe(false);
  });

  it('refuses an id that is not a numeric Meta id, since the URL is built from it', () => {
    const input = { appId: APP_ID, configId: CONFIG_ID, redirectUri: REDIRECT, state: 's' };
    expect(() => loginDialogUrl({ ...input, appId: 'not-an-id' })).toThrow(/numeric Meta id/);
    expect(() => loginDialogUrl({ ...input, configId: '12' })).toThrow(/numeric Meta id/);
    expect(() => loginDialogUrl({ ...input, configId: `${CONFIG_ID}&scope=x` })).toThrow();
  });
});

describe('tokenExchangeUrl', () => {
  it('is GET /oauth/access_token on graph.facebook.com with the four documented parameters', () => {
    const url = tokenExchangeUrl({
      appId: APP_ID,
      appSecret: 'app-secret',
      redirectUri: REDIRECT,
      code: 'the-code',
    });

    expect(url.host).toBe('graph.facebook.com');
    expect(url.pathname).toBe(`/${GRAPH_VERSION}/oauth/access_token`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_ID,
      client_secret: 'app-secret',
      redirect_uri: REDIRECT,
      code: 'the-code',
    });
  });

  it('refuses a non-numeric app id', () => {
    expect(() =>
      tokenExchangeUrl({ appId: 'x', appSecret: 's', redirectUri: REDIRECT, code: 'c' }),
    ).toThrow(/numeric Meta id/);
  });
});

describe('readCallbackParams', () => {
  it('reads a code with its state', () => {
    expect(readCallbackParams(new URLSearchParams('code=abc&state=xyz'))).toEqual({
      kind: 'code',
      code: 'abc',
      state: 'xyz',
    });
  });

  it('reads a cancelled dialog with Meta’s reason', () => {
    const params = new URLSearchParams(
      'error=access_denied&error_reason=user_denied&error_description=Permissions+error',
    );
    expect(readCallbackParams(params)).toEqual({
      kind: 'cancelled',
      reason: 'access_denied: Permissions error',
    });
    // The reason falls back to `error_reason`, then to the error alone.
    expect(readCallbackParams(new URLSearchParams('error=access_denied&error_reason=x'))).toEqual({
      kind: 'cancelled',
      reason: 'access_denied: x',
    });
    expect(readCallbackParams(new URLSearchParams('error=access_denied'))).toEqual({
      kind: 'cancelled',
      reason: 'access_denied',
    });
  });

  it('calls anything else invalid, naming what is missing', () => {
    expect(readCallbackParams(new URLSearchParams(''))).toEqual({
      kind: 'invalid',
      reason: 'Meta sent back no code',
    });
    expect(readCallbackParams(new URLSearchParams('code=abc'))).toEqual({
      kind: 'invalid',
      reason: 'Meta sent back no state',
    });
  });
});

describe('the state', () => {
  it('is 32 random bytes as base64url, different every time', () => {
    const a = newState();
    const b = newState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('matches only itself, and never an absent cookie', () => {
    const state = newState();
    expect(sameState(state, state)).toBe(true);
    expect(sameState(state, newState())).toBe(false);
    expect(sameState(state, state.slice(1))).toBe(false);
    expect(sameState(null, state)).toBe(false);
    expect(sameState('', '')).toBe(false);
  });

  it('is set HttpOnly, Lax, on the two routes’ path, for ten minutes, and cleared the same way', () => {
    const set = stateCookie('the-state', true);
    expect(set).toBe(
      `${STATE_COOKIE}=the-state; Path=/api/meta/unified-login; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
    );
    // Secure dropped for a laptop over http, where a browser would refuse to
    // store the cookie at all.
    expect(stateCookie('the-state', false)).not.toContain('Secure');
    expect(clearedStateCookie(true)).toBe(
      `${STATE_COOKIE}=; Path=/api/meta/unified-login; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  it('is read back out of a Cookie header among other cookies', () => {
    expect(readStateCookie(`sb_session=abc; ${STATE_COOKIE}=the-state; other=1`)).toBe('the-state');
    expect(readStateCookie('sb_session=abc')).toBeNull();
    expect(readStateCookie(null)).toBeNull();
    expect(readStateCookie(`${STATE_COOKIE}=`)).toBeNull();
  });
});

describe('refuseInspection', () => {
  it('refuses a token Meta says is not valid, with Meta’s sentence', () => {
    expect(
      refuseInspection(inspection({ isValid: false, error: 'Session has expired' }), APP_ID),
    ).toBe('Meta says this token is not valid: Session has expired.');
    expect(refuseInspection(inspection({ isValid: false }), APP_ID)).toBe(
      'Meta says this token is not valid.',
    );
  });

  it('refuses a token minted for another app, naming both', () => {
    const refusal = refuseInspection(inspection({ appId: '111111111111' }), APP_ID);
    expect(refusal).toContain('minted this token for app 111111111111');
    expect(refusal).toContain(`this environment is app ${APP_ID}`);
  });

  it('accepts a valid token for this app, and one whose app Meta did not report', () => {
    expect(refuseInspection(inspection(), APP_ID)).toBeNull();
    expect(refuseInspection(inspection({ appId: null }), APP_ID)).toBeNull();
  });

  it('only warns about a type other than SYSTEM_USER, since the reported type is unobserved', () => {
    expect(inspectionWarning(inspection())).toBeNull();
    expect(inspectionWarning(inspection({ type: 'USER' }))).toContain('USER, not SYSTEM_USER');
    expect(inspectionWarning(inspection({ type: null }))).toContain('nothing, not SYSTEM_USER');
    // A warning is not a refusal: the same inspection passes `refuseInspection`.
    expect(refuseInspection(inspection({ type: 'USER' }), APP_ID)).toBeNull();
  });
});

describe('callbackPage', () => {
  const connected = {
    kind: 'connected' as const,
    token: TOKEN,
    accounts: [{ id: '17841448759001625', username: 'shipblu' }],
    inspection: inspection(),
    clientBusinessId: '555555555555',
    warnings: [],
    configuredAccountId: '17841448759001625',
  };

  it('shows the token once, as the text of the textarea and nowhere else', () => {
    const html = callbackPage(connected);

    expect(html.split(TOKEN).length - 1).toBe(1);
    expect(html).toContain(`<textarea id="token" readonly>${TOKEN}</textarea>`);
    // Not in any attribute (quoted) and not in a URL.
    expect(html).not.toMatch(new RegExp(`="[^"]*${TOKEN}`));
    expect(html).not.toMatch(new RegExp(`(href|src|action)=[^>]*${TOKEN}`));
    expect(html).not.toMatch(new RegExp(`https?://[^\\s"'<]*${TOKEN}`));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Instagram connected through Unified Login');
    expect(html).toContain('@shipblu');
    expect(html).toContain('the account this environment replies as');
    expect(html).toContain('never');
    expect(html).toContain('555555555555');
    expect(html).toContain('INSTAGRAM_UNIFIED_LOGIN_TOKEN');
    expect(html).toContain('subscribe_meta_webhooks object=instagram');
    expect(html).toContain('href="/admin/channels"');
  });

  it('escapes everything it interpolates', () => {
    const html = callbackPage({
      ...connected,
      token: 'tok<script>alert(1)</script>',
      accounts: [{ id: '123', username: '<img src=x onerror=alert(1)>' }],
      clientBusinessId: '"quoted"',
      warnings: ['a & b <c>'],
      inspection: inspection({ type: '<b>', scopes: ['instagram_basic<'] }),
    });

    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('tok&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('a &amp; b &lt;c&gt;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('warns when the configured account is not among the ones the token reaches, or is unset', () => {
    const elsewhere = callbackPage({ ...connected, configuredAccountId: '999' });
    expect(elsewhere).toContain('this token cannot address it');
    expect(elsewhere).toContain('<code>999</code>');

    const unset = callbackPage({ ...connected, configuredAccountId: null });
    expect(unset).toContain('<code>INSTAGRAM_ACCOUNT_ID</code> is not set');
    expect(unset).not.toContain('this token cannot address it');
  });

  it('lists the permissions the token is missing against the connection’s required scopes', () => {
    const html = callbackPage({
      ...connected,
      inspection: inspection({ scopes: ['instagram_basic'] }),
    });
    expect(html).toContain('Missing from the token, and needed:');
    expect(html).toContain('<code>instagram_manage_messages</code>');
    expect(callbackPage(connected)).not.toContain('Missing from the token');
  });

  it('draws nothing for an inspection that did not answer, and prints an expiry when there is one', () => {
    // The callback puts the reason among the warnings; a second sentence here
    // was the same thing read twice.
    const silent = callbackPage({ ...connected, inspection: null });
    expect(silent).not.toContain('What Meta says about the token');
    expect(silent).not.toContain('did not answer');
    expect(silent.split(connected.token).length - 1).toBe(1);

    const expiring = callbackPage({
      ...connected,
      inspection: inspection({ expiresAt: new Date('2027-01-01T00:00:00Z') }),
    });
    expect(expiring).toContain('2027-01-01T00:00:00.000Z');
  });

  it('renders a cancelled dialog and a refusal without a token', () => {
    const cancelled = callbackPage({ kind: 'cancelled', reason: 'access_denied: user_denied' });
    expect(cancelled).toContain('Nothing was changed');
    expect(cancelled).toContain('access_denied: user_denied');
    expect(cancelled).not.toContain('<textarea');

    const refused = callbackPage({ kind: 'refused', reason: 'Meta says <no>' });
    expect(refused).toContain('Instagram was not connected');
    expect(refused).toContain('Meta says &lt;no&gt;');
    expect(refused).not.toContain('<textarea');
  });

  it('keeps to one light palette and no title attributes', () => {
    const html = callbackPage(connected);
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).not.toMatch(/\stitle="/);
    expect(html).toContain('color-scheme: light');
  });
});

describe('unifiedLoginReadiness', () => {
  withTestEnv();

  it('names every missing variable at once, with why', () => {
    const readiness = unifiedLoginReadiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.missing.map((setting) => setting.variable)).toEqual([
      'META_APP_ID',
      'META_APP_SECRET',
      'INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID',
      'APP_URL',
    ]);
    for (const setting of readiness.missing) expect(setting.why.length).toBeGreaterThan(20);
  });

  it('is ready with the four set, and builds the callback on APP_URL', () => {
    setTestEnv({
      META_APP_ID: APP_ID,
      META_APP_SECRET: 'secret',
      INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID: CONFIG_ID,
      APP_URL: 'https://support.example.com/',
    });

    expect(unifiedLoginReadiness()).toEqual({
      ready: true,
      appId: APP_ID,
      configId: CONFIG_ID,
      redirectUri: `https://support.example.com${CALLBACK_PATH}`,
    });
  });
});
