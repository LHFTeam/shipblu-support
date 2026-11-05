import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { STATE_COOKIE } from '@/lib/meta/unified-login';

/**
 * Where "Connect Instagram" starts. What matters: nobody but a connect-holder
 * is sent to Meta; an environment missing a variable is told which, not sent;
 * and the `state` the cookie holds is the one the dialog is opened with — the
 * half the callback's tests assume when they hand the route a matching pair.
 */

type Agent = { id: string; role: string; permissions: Record<string, boolean> };

const session = vi.fn<() => Promise<Agent | null>>();
vi.mock('@/lib/auth/session', () => ({ getSessionAgent: () => session() }));

const { GET } = await import('./route');

const APP_ID = '1234567890123456';
const CONFIG_ID = '9876543210987654';

withTestEnv({
  META_APP_ID: APP_ID,
  META_APP_SECRET: 'app-secret-0123456789abcdef',
  INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID: CONFIG_ID,
  APP_URL: 'https://support.example.com',
});

const admin: Agent = { id: 'a-1', role: 'admin', permissions: {} };

/** The `Set-Cookie` the route answers with, split into its value and attributes. */
function cookie(response: Response): { value: string; attributes: string[] } {
  const header = response.headers.get('set-cookie') ?? '';
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  expect(pair?.startsWith(`${STATE_COOKIE}=`)).toBe(true);
  return { value: pair!.slice(STATE_COOKIE.length + 1), attributes };
}

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(admin);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/meta/unified-login/start', () => {
  it('answers 401 without a session and 403 without admin.channels.connect', async () => {
    session.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);

    session.mockResolvedValue({ id: 'a-2', role: 'agent', permissions: {} });
    const forbidden = await GET();
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('set-cookie')).toBeNull();
    expect(forbidden.headers.get('location')).toBeNull();
  });

  it('names the missing variables instead of opening a dialog Meta would refuse', async () => {
    setTestEnv({ INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID: undefined, APP_URL: undefined });

    const response = await GET();

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID');
    expect(text).toContain('APP_URL');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('opens the dialog with the state the cookie holds, bound to the login path', async () => {
    const response = await GET();

    expect(response.status).toBe(302);
    const dialog = new URL(response.headers.get('location')!);
    expect(dialog.host).toBe('www.facebook.com');
    expect(dialog.pathname.endsWith('/dialog/oauth')).toBe(true);
    expect(dialog.searchParams.get('client_id')).toBe(APP_ID);
    expect(dialog.searchParams.get('config_id')).toBe(CONFIG_ID);
    expect(dialog.searchParams.get('redirect_uri')).toBe(
      'https://support.example.com/api/meta/unified-login/callback',
    );
    expect(dialog.searchParams.get('response_type')).toBe('code');
    expect(dialog.searchParams.has('scope')).toBe(false);

    // The one thing that binds the callback to this browser: the same value
    // in the cookie and in the dialog, fresh per request.
    const { value, attributes } = cookie(response);
    expect(value).toBe(dialog.searchParams.get('state'));
    expect(value).toHaveLength(43);
    expect(attributes).toEqual(
      expect.arrayContaining([
        'Path=/api/meta/unified-login',
        'HttpOnly',
        'SameSite=Lax',
        'Secure',
      ]),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');

    const again = await GET();
    expect(cookie(again).value).not.toBe(value);
  });

  it('drops Secure for an http APP_URL, which is a laptop, and keeps the rest', async () => {
    setTestEnv({ APP_URL: 'http://localhost:3000' });

    const { attributes } = cookie(await GET());

    expect(attributes).not.toContain('Secure');
    expect(attributes).toContain('HttpOnly');
  });
});
