import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';

/**
 * The Facebook and Instagram webhook's decisions: which secret signed a
 * delivery, which connection that makes it, the delivery id it is stored
 * under, what Meta is told, and whether a job is queued.
 *
 * Instagram is connected twice and the two connections sign byte-identical
 * bodies with different app secrets (§6.26, §6.29). The secret that verifies
 * is the only thing that says which connection a delivery came in on, and the
 * connection is part of the delivery id — so the same message arriving on both
 * is two rows, and arriving twice on one is a duplicate.
 *
 * The database and the queue are recorders, as in the other webhook tests;
 * `conflict` stands in for the unique index. Signatures are real HMACs.
 */

const writes: Record<string, unknown>[] = [];
const conflictTargets: unknown[] = [];
let conflict = false;

vi.mock('@/db/client', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.push(values);
        return {
          onConflictDoNothing: ({ target }: { target: unknown }) => {
            conflictTargets.push(target);
            return { returning: async () => (conflict ? [] : [{ id: 'event-1' }]) };
          },
        };
      },
    }),
  },
}));

const enqueue = vi.fn(async () => {});
vi.mock('@/lib/queue', () => ({ enqueue }));
vi.mock('@/lib/webhooks/log', () => ({ logIncomingWebhook: () => {} }));

const { GET, POST } = await import('./route');
const { webhookEvents } = await import('@/db/schema');
const { resetVerifyingSecretNotice } = await import('@/lib/meta/signing');

const PAGE_SECRET = 'page-app-secret';
const INSTAGRAM_SECRET = 'instagram-login-secret';

const message = (object: 'page' | 'instagram') => ({
  object,
  entry: [
    { id: '17841400000000000', messaging: [{ sender: { id: 'user-1' }, message: { mid: 'm_1' } }] },
  ],
});

function sign(body: string, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function deliver(payload: unknown, secret: string | null) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: 'Bearer private',
    cookie: 'session=private',
  };
  if (secret) headers['x-hub-signature-256'] = sign(body, secret);
  return POST(
    new Request('https://support.example/api/webhooks/meta', { method: 'POST', headers, body }),
  );
}

withTestEnv({
  META_APP_SECRET: PAGE_SECRET,
  INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
  META_VERIFY_TOKEN: 'verify-me',
});

beforeEach(() => {
  writes.length = 0;
  conflictTargets.length = 0;
  conflict = false;
  enqueue.mockClear();
  // The once-per-secret notice is module state; without this, which test
  // logged first would decide what the others see.
  resetVerifyingSecretNotice();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the subscription handshake', () => {
  it('answers the bare challenge to the right token, and refuses another', async () => {
    const handshake = (token: string) =>
      GET(
        new Request(
          `https://support.example/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`,
        ),
      );

    const accepted = await handshake('verify-me');
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe('42');
    expect((await handshake('guess')).status).toBe(403);
  });

  it('says it is not configured rather than refusing, when there is no token', async () => {
    setTestEnv({ META_VERIFY_TOKEN: undefined });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(
      new Request(
        'https://support.example/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42',
      ),
    );

    expect(response.status).toBe(500);
  });
});

describe('a signed delivery', () => {
  it.each([
    ['a Page delivery signed by the app secret', 'page', PAGE_SECRET, 'facebook', 'facebook_page'],
    [
      'an Instagram delivery signed by the app secret',
      'instagram',
      PAGE_SECRET,
      'instagram',
      'facebook_page',
    ],
    [
      'an Instagram delivery signed by the Instagram Login secret',
      'instagram',
      INSTAGRAM_SECRET,
      'instagram',
      'instagram_login',
    ],
  ] as const)(
    '%s is stored on its connection, under an id naming it, and queued',
    async (_what, object, secret, channel, connection) => {
      const response = await deliver(message(object), secret);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'queued' });
      expect(writes).toEqual([
        expect.objectContaining({
          provider: 'meta',
          channel,
          connection,
          providerEventId: `${connection}|m:m_1`,
          payload: message(object),
          signatureVerified: true,
          error: null,
        }),
      ]);
      expect(conflictTargets).toEqual([[webhookEvents.provider, webhookEvents.providerEventId]]);
      expect(enqueue).toHaveBeenCalledWith(
        'process_webhook',
        { webhookEventId: 'event-1' },
        { priority: 10, dedupeKey: 'process_webhook:event-1' },
      );
    },
  );

  it('accepts the Instagram secret under its legacy name too', async () => {
    setTestEnv({ INSTAGRAM_APP_SECRET: undefined, META_INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET });

    await deliver(message('instagram'), INSTAGRAM_SECRET);

    expect(writes[0]).toMatchObject({ connection: 'instagram_login', signatureVerified: true });
  });

  it('tries the legacy name too when both are set to different values', async () => {
    setTestEnv({ META_INSTAGRAM_APP_SECRET: 'legacy-instagram-secret' });

    await deliver(message('instagram'), 'legacy-instagram-secret');

    expect(writes[0]).toMatchObject({ connection: 'instagram_login', signatureVerified: true });
  });

  /**
   * The signature covers the bytes Meta sent, which are not what
   * `JSON.stringify` would produce from the parsed object.
   */
  it('verifies the bytes as sent, not the payload re-serialised', async () => {
    const raw = '{ "entry": [], "object": "page" }';

    const response = await deliver(raw, PAGE_SECRET);

    expect(response.status).toBe(200);
    expect(writes[0]).toMatchObject({ signatureVerified: true, payload: JSON.parse(raw) });
  });

  it('does not accept the Instagram secret on a Page delivery', async () => {
    const response = await deliver(message('page'), INSTAGRAM_SECRET);

    expect(response.status).toBe(403);
    expect(writes[0]).toMatchObject({
      signatureVerified: false,
      error: 'signature did not match META_APP_SECRET',
    });
  });

  it('keeps the signature as evidence and drops the credentials', async () => {
    await deliver(message('page'), PAGE_SECRET);

    const headers = writes[0]!.headers as Record<string, string>;
    expect(headers['x-hub-signature-256']).toMatch(/^sha256=/);
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('cookie');
  });

  it('answers a redelivery 200, so Meta stops, and queues nothing', async () => {
    conflict = true;

    const response = await deliver(message('page'), PAGE_SECRET);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'duplicate' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('an unsigned delivery', () => {
  it('is stored as evidence under no id and no connection, with the secrets it tried, and refused', async () => {
    const response = await deliver(message('instagram'), 'forged');

    expect(response.status).toBe(403);
    expect(writes).toEqual([
      expect.objectContaining({
        providerEventId: null,
        connection: null,
        signatureVerified: false,
        error: 'signature did not match INSTAGRAM_APP_SECRET or META_APP_SECRET',
      }),
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('says so when no secret is configured at all', async () => {
    setTestEnv({ META_APP_SECRET: undefined });

    const response = await deliver(message('page'), PAGE_SECRET);

    expect(response.status).toBe(403);
    expect(writes[0]).toMatchObject({
      error: 'signature not verified: no app secret is configured (META_APP_SECRET)',
    });
  });
});

it('refuses a body that is not JSON, and stores nothing', async () => {
  const response = await deliver('{not json', PAGE_SECRET);

  expect(response.status).toBe(400);
  expect(writes).toEqual([]);
});
