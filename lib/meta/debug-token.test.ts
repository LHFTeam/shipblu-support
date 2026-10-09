import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { stubFetch } from '@/lib/testing/fetch';
import { inspectToken } from './debug-token';

/**
 * `inspectToken` is the one place a live token is put in a URL — `debug_token`
 * takes it as `input_token` and has no other shape — so what it must never do
 * is repeat that URL, or anything carrying the token, in a sentence. The rest
 * is reading Meta's `0` as "never" rather than as the epoch.
 */

const TOKEN = 'EAAGm0PX4ZCpsBAEXAMPLEtokenValue1234567890';

withTestEnv({ META_APP_ID: '123', META_APP_SECRET: 'app-secret' });

describe('inspectToken', () => {
  it('asks with the app token in the header and the inspected token in the query', async () => {
    const fetch = stubFetch(
      async () =>
        new Response(
          JSON.stringify({ data: { is_valid: true, app_id: '123', type: 'SYSTEM_USER' } }),
          {
            status: 200,
          },
        ),
    );

    await inspectToken(TOKEN);

    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toMatch(/\/debug_token$/);
    expect(new URL(String(url)).searchParams.get('input_token')).toBe(TOKEN);
    expect(String(url)).not.toContain('app-secret');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer 123|app-secret');
  });

  it("reads Meta's 0 as never, and seconds as an instant", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              type: 'SYSTEM_USER',
              app_id: '123',
              is_valid: true,
              issued_at: 1_790_000_000,
              expires_at: 0,
              data_access_expires_at: 0,
              scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
              granular_scopes: [
                { scope: 'whatsapp_business_management', target_ids: ['102030405060708'] },
                { scope: 'whatsapp_business_messaging' },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    expect(await inspectToken(TOKEN)).toEqual({
      type: 'SYSTEM_USER',
      appId: '123',
      isValid: true,
      issuedAt: new Date(1_790_000_000 * 1000),
      expiresAt: null,
      dataAccessExpiresAt: null,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      granularScopes: [
        { scope: 'whatsapp_business_management', targetIds: ['102030405060708'] },
        // Absent targets are "not narrowed", which a caller must not read as "none".
        { scope: 'whatsapp_business_messaging', targetIds: null },
      ],
      error: null,
    });
  });

  it('answers a rejected token as an answer, with Meta’s sentence', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: { is_valid: false, error: { message: 'Session has expired on Tuesday' } },
          }),
          { status: 200 },
        ),
    );

    const inspection = await inspectToken(TOKEN);
    expect(inspection.isValid).toBe(false);
    expect(inspection.error).toBe('Session has expired on Tuesday');
  });

  it('never repeats the token when the network fails with it in the message', async () => {
    stubFetch(async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    });

    const failure = await inspectToken(TOKEN).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/\/debug_token could not be reached/);
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it('never repeats the token when Meta echoes it back in a refusal', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: { message: `Invalid OAuth token ${TOKEN}` } }), {
          status: 400,
        }),
    );

    const failure = await inspectToken(TOKEN).catch((error: Error) => error);
    expect((failure as Error).message).toMatch(/^debug_token failed \(HTTP 400\)/);
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it('names the app variables it needs instead of calling Meta without them', async () => {
    const fetch = stubFetch(async () => new Response('{}'));
    setTestEnv({ META_APP_SECRET: undefined });

    await expect(inspectToken(TOKEN)).rejects.toThrow(/^META_APP_SECRET must be set/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
