import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { STATE_COOKIE } from '@/lib/meta/unified-login';

/**
 * Where Meta sends the admin back with the code. What matters: nobody but a
 * connect-holder is answered; nothing is sent to Meta until the state proves
 * the callback is this browser's; the token reaches the page once and no
 * cache; and a failure's page repeats neither the code nor the app secret.
 */

type Agent = { id: string; role: string; permissions: Record<string, boolean> };

const session = vi.fn<() => Promise<Agent | null>>();
vi.mock('@/lib/auth/session', () => ({ getSessionAgent: () => session() }));

const { GET } = await import('./route');

const APP_ID = '1234567890123456';
const APP_SECRET = 'app-secret-0123456789abcdef';
const CODE = 'AQD-the-code-meta-sent-back-0123456789';
const TOKEN = 'EAAUnifiedLoginTokenThatIsLongEnoughToBeRealistic1234567890';
const STATE = 'state-bound-to-this-browser';
const CALLBACK = 'https://support.example.com/api/meta/unified-login/callback';

withTestEnv({
  META_APP_ID: APP_ID,
  META_APP_SECRET: APP_SECRET,
  INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID: '9876543210987654',
  APP_URL: 'https://support.example.com',
  INSTAGRAM_ACCOUNT_ID: '17841448759001625',
});

type Answer = { status?: number; body: unknown };
/** What the mocked Graph answers each path with; `requests` records what was asked. */
let answers: Record<string, Answer | (() => never)>;
let requests: { url: URL; init: RequestInit | undefined }[];

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  requests.push({ url, init });
  const key = Object.keys(answers).find((path) => url.pathname.endsWith(path));
  if (!key) throw new Error(`unexpected request to ${url.host}${url.pathname}`);
  const answer = answers[key]!;
  if (typeof answer === 'function') answer();
  const { status = 200, body } = answer as Answer;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
});

function happyAnswers(): Record<string, Answer> {
  return {
    '/oauth/access_token': { body: { access_token: TOKEN, token_type: 'bearer' } },
    '/debug_token': {
      body: {
        data: {
          type: 'SYSTEM_USER',
          app_id: APP_ID,
          is_valid: true,
          expires_at: 0,
          scopes: ['instagram_basic', 'instagram_manage_messages'],
        },
      },
    },
    '/me/assigned_instagram_accounts': {
      body: { data: [{ id: '17841448759001625', username: 'shipblu' }] },
    },
    '/me': { body: { client_business_id: '555555555555', id: '777' } },
  };
}

function request(query: string, cookie: string | null = `${STATE_COOKIE}=${STATE}`) {
  return new Request(`${CALLBACK}?${query}`, {
    headers: cookie ? { cookie: `sb_session=abc; ${cookie}` } : {},
  });
}

const admin: Agent = { id: 'a-1', role: 'admin', permissions: {} };

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(admin);
  requests = [];
  answers = happyAnswers();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  // The route logs one line per outcome; the lines are not what is tested.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/meta/unified-login/callback', () => {
  it('answers 401 without a session and 403 without admin.channels.connect, calling nothing', async () => {
    session.mockResolvedValue(null);
    expect((await GET(request(`code=${CODE}&state=${STATE}`))).status).toBe(401);

    session.mockResolvedValue({ id: 'a-2', role: 'agent', permissions: {} });
    expect((await GET(request(`code=${CODE}&state=${STATE}`))).status).toBe(403);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a state that does not match the cookie before anything is sent to Meta', async () => {
    const response = await GET(request(`code=${CODE}&state=somebody-elses-state`));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('not opened from the console, or it expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a callback with no cookie at all, and one with no code', async () => {
    expect((await GET(request(`code=${CODE}&state=${STATE}`, null))).status).toBe(400);
    expect((await GET(request(`state=${STATE}`))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges the code, proves the token and shows it once, uncached, clearing the cookie', async () => {
    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('set-cookie')).toBe(
      `${STATE_COOKIE}=; Path=/api/meta/unified-login; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );

    expect(html.split(TOKEN).length - 1).toBe(1);
    expect(html).toContain('Instagram connected through Unified Login');
    expect(html).toContain('@shipblu');
    expect(html).toContain('555555555555');
    expect(html).not.toContain(APP_SECRET);
    expect(html).not.toContain(CODE);

    // The exchange is the Meta app's, on graph.facebook.com, with the
    // callback as the redirect; the reads carry the new token as a bearer
    // header and never in their URL.
    const exchange = requests.find((r) => r.url.pathname.endsWith('/oauth/access_token'))!;
    expect(exchange.url.host).toBe('graph.facebook.com');
    expect(Object.fromEntries(exchange.url.searchParams)).toEqual({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: CALLBACK,
      code: CODE,
    });
    const reads = requests.filter((r) => !r.url.pathname.endsWith('/oauth/access_token'));
    expect(reads.map((r) => r.url.pathname.replace(/^\/v[\d.]+/, '')).sort()).toEqual([
      '/debug_token',
      '/me',
      '/me/assigned_instagram_accounts',
    ]);
    for (const read of reads) {
      // `debug_token` is the one exception: `input_token` is a query parameter
      // and the endpoint has no other shape (`lib/meta/debug-token.ts`).
      if (read.url.pathname.endsWith('/debug_token')) continue;
      expect(read.url.toString()).not.toContain(TOKEN);
      expect(new Headers(read.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('answers a cancelled dialog with a page saying nothing changed, calling Meta for nothing', async () => {
    const response = await GET(
      request('error=access_denied&error_reason=user_denied&error_description=Denied'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('Nothing was changed');
    expect(html).toContain('access_denied: Denied');
    expect(html).not.toContain('<textarea');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a refused exchange into a 502 page that repeats neither the code nor the secret', async () => {
    answers['/oauth/access_token'] = {
      status: 400,
      body: {
        error: {
          message: `Invalid verification code format: ${CODE} with ${APP_SECRET}`,
          code: 100,
        },
      },
    };

    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).toContain('Instagram was not connected');
    expect(html).toContain('Meta refused the login code');
    expect(html).toContain('[redacted]');
    expect(html).not.toContain(CODE);
    expect(html).not.toContain(APP_SECRET);
    expect(html).not.toContain(TOKEN);
    // Nothing else was asked once the exchange failed.
    expect(requests).toHaveLength(1);
  });

  it('turns a network failure on the exchange into a 502 page naming host and path only', async () => {
    answers['/oauth/access_token'] = () => {
      throw new TypeError('fetch failed');
    };

    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).toContain('graph.facebook.com/');
    expect(html).toContain('oauth/access_token could not be reached');
    expect(html).not.toContain(CODE);
    expect(html).not.toContain(APP_SECRET);
  });

  it('refuses a token Meta says is for another app, and never shows it', async () => {
    answers['/debug_token'] = {
      body: { data: { type: 'SYSTEM_USER', app_id: '111111111111', is_valid: true, scopes: [] } },
    };

    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(html).toContain('minted this token for app 111111111111');
    expect(html).not.toContain(TOKEN);
  });

  it('accepts a token whose account list is empty when it reads the configured account directly', async () => {
    // 2026-11-05: two logins, the portfolio listing the account as shared, and
    // an empty list both times. The read every reply makes is the proof.
    answers['/me/assigned_instagram_accounts'] = { body: { data: [] } };
    answers['/17841448759001625'] = { body: { id: '17841448759001625', username: 'shipblu' } };

    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html.split(TOKEN).length - 1).toBe(1);
    expect(html).toContain('@shipblu');
    expect(html).toContain('list of the token');
    expect(html).toContain('was empty, but the token reads 17841448759001625 directly');
    const probe = requests.find((entry) => entry.url.pathname.endsWith('/17841448759001625'));
    expect(probe?.url.searchParams.get('fields')).toBe('id,username');
    expect(new Headers(probe?.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses a token that reaches no account, naming the permissions it carries and Graph\u2019s sentence', async () => {
    answers['/me/assigned_instagram_accounts'] = { body: { data: [] } };
    answers['/17841448759001625'] = {
      status: 400,
      body: {
        error: {
          message:
            'Unsupported get request. Object with ID \u201817841448759001625\u2019 does not exist',
          code: 100,
          error_subcode: 33,
        },
      },
    };

    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(html).toContain('reaches no Instagram account');
    expect(html).not.toContain(TOKEN);
    // The facts, not a guess about the dialog: the scopes, the missing
    // prerequisite, the portfolio and what the account said.
    expect(html).toContain('instagram_basic, instagram_manage_messages');
    expect(html).toContain('business_management');
    expect(html).toContain('555555555555');
    expect(html).toContain('Unsupported get request');
  });

  it('says so when INSTAGRAM_ACCOUNT_ID is unset and the list is empty, probing nothing', async () => {
    setTestEnv({ INSTAGRAM_ACCOUNT_ID: undefined });
    answers['/me/assigned_instagram_accounts'] = { body: { data: [] } };

    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(html).toContain('INSTAGRAM_ACCOUNT_ID is unset');
    expect(html).not.toContain(TOKEN);
    expect(requests.some((entry) => entry.url.pathname.endsWith('/17841448759001625'))).toBe(false);
  });

  it('still shows the token when the inspection and the business read do not answer, with warnings', async () => {
    answers['/debug_token'] = { status: 500, body: { error: { message: 'down' } } };
    answers['/me'] = {
      status: 500,
      body: { error: { message: `portfolio read failed ${TOKEN}` } },
    };

    const response = await GET(request(`code=${CODE}&state=${STATE}`));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html.split(TOKEN).length - 1).toBe(1);
    expect(html).toContain('token inspection did not answer');
    expect(html).toContain('did not say which business portfolio');
    expect(html).toContain('[redacted]');
  });

  it('warns when INSTAGRAM_ACCOUNT_ID is not among the accounts the token reaches', async () => {
    setTestEnv({ INSTAGRAM_ACCOUNT_ID: '999999999999' });

    const html = await (await GET(request(`code=${CODE}&state=${STATE}`))).text();

    expect(html).toContain('this token cannot address it');
  });
});
