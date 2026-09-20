import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { ShipbluApiError } from '@/lib/shipments/platform';
import { clearIntrospectionCache, introspect } from './platform';

/**
 * The introspection round trip.
 *
 * `readProfile` is tested beside the identity rules it feeds; what is left here
 * is the half that decides whether a customer stays signed in — which status
 * means "this credential is dead" and which means "ask again later" — and the
 * cache, which is the only thing standing between a flaky network and three
 * outbound calls per handshake.
 */

const ORIGINAL = process.env;
const BASE = 'https://platform.test';

function respond(status: number, body: unknown = {}) {
  return vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
  } as NodeJS.ProcessEnv;
  resetEnvCache();
  clearIntrospectionCache();
});

afterEach(() => {
  process.env = ORIGINAL;
  resetEnvCache();
  vi.unstubAllGlobals();
});

describe('what a status means', () => {
  it('treats 401 and 403 as the platform rejecting the token', async () => {
    for (const status of [401, 403]) {
      clearIntrospectionCache();
      vi.stubGlobal('fetch', respond(status));

      // The caller turns this into the one 401 this API answers, which the app
      // meets by signing the customer out of myBlu entirely.
      await expect(introspect(`token-${status}`, BASE)).rejects.toMatchObject({
        status: 401,
        isTransient: false,
      });
    }
  });

  it('does NOT treat 404 as a dead token', async () => {
    vi.stubGlobal('fetch', respond(404));

    // A 404 is at least as likely to mean the endpoint moved or lost its
    // trailing slash behind a proxy. Reading a deploy as a dead credential
    // would force-sign-out every myBlu user from the consumer app, so an
    // ambiguous status resolves to the recoverable side.
    const error = await introspect('token', BASE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShipbluApiError);
    expect((error as ShipbluApiError).status).not.toBe(401);
  });

  it('treats 5xx and 429 as transient, and never as a session', async () => {
    for (const status of [429, 500, 503]) {
      clearIntrospectionCache();
      vi.stubGlobal('fetch', respond(status));
      await expect(introspect(`t-${status}`, BASE)).rejects.toMatchObject({ isTransient: true });
    }
  });

  it('refuses a 200 that is not JSON rather than reading it as an empty profile', async () => {
    // A captive portal or a proxy answering instead of the platform. Parsing it
    // as "a live token naming nobody" would hand out a device-scoped session on
    // a credential nothing checked.
    vi.stubGlobal('fetch', respond(200, 'maintenance</html>'));
    await expect(introspect('token', BASE)).rejects.toBeInstanceOf(ShipbluApiError);
  });

  it('is a throw, never a session, when the platform cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(introspect('token', BASE)).rejects.toMatchObject({ isTransient: true });
  });
});

describe('the cache', () => {
  it('answers a repeated handshake without a second round trip', async () => {
    // An app retrying on a flaky connection must not triple the load on
    // api.shipblu.com — this endpoint is the one place a client can make this
    // system call the platform on demand.
    const fetchMock = respond(200, { phone: '+201001234567' });
    vi.stubGlobal('fetch', fetchMock);

    const first = await introspect('same-token', BASE);
    const second = await introspect('same-token', BASE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.subject).toBe('phone:201001234567');
  });

  it("keeps one token's answer away from another's", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ phone: '201001111111' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ phone: '201002222222' })));
    vi.stubGlobal('fetch', fetchMock);

    expect((await introspect('token-a', BASE)).subject).toBe('phone:201001111111');
    expect((await introspect('token-b', BASE)).subject).toBe('phone:201002222222');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure', async () => {
    // A cached rejection would turn one bad minute at the platform into a
    // minute of failures for a customer whose next attempt would have worked.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ phone: '201003333333' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(introspect('token', BASE)).rejects.toBeInstanceOf(ShipbluApiError);
    expect((await introspect('token', BASE)).subject).toBe('phone:201003333333');
  });

  it('sends the bearer, and sends it only to the configured platform', async () => {
    const fetchMock = respond(200, {});
    vi.stubGlobal('fetch', fetchMock);

    await introspect('the-secret-token', BASE);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/v1/myshipblu/customer-accounts/`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer the-secret-token');
  });
});
