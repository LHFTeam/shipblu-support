import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';

/**
 * The WhatsApp webhook's decisions: the handshake, which delivery id a stored
 * payload carries, what Meta is told, and whether a job is queued.
 *
 * The database and the queue are recorders, as in the email route's test,
 * because the questions are about what the route asks them for. The unique
 * index on `(provider, provider_event_id)` is simulated by `conflict`: the
 * insert then returns no row, which is what `onConflictDoNothing` answers. The
 * signature is real — an HMAC over the exact bytes — so a test that passes is
 * one Meta's own signing would pass.
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

const SECRET = 'whatsapp-app-secret';

// Out of order within a kind, and with an echo, so the id has to be sorted and
// has to count all three kinds.
const BATCH = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [{ id: 'wamid.Z' }, { id: 'wamid.M' }],
            message_echoes: [{ id: 'wamid.E' }],
            statuses: [{ id: 'wamid.A', status: 'delivered' }],
          },
        },
      ],
    },
  ],
};

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function deliver(
  payload: unknown = BATCH,
  signature: string | null = sign(JSON.stringify(payload)),
) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: 'Bearer private',
    cookie: 'session=private',
  };
  if (signature) headers['x-hub-signature-256'] = signature;
  return POST(
    new Request('https://support.example/api/webhooks/whatsapp', { method: 'POST', headers, body }),
  );
}

withTestEnv({ META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'verify-me' });

beforeEach(() => {
  writes.length = 0;
  // Reset with the other recorders: the conflict-target assertion compares the
  // whole array, so without this it passes only while its test is the file's
  // first POST, and any reorder or new test above it fails it for no reason.
  conflictTargets.length = 0;
  conflict = false;
  enqueue.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the subscription handshake', () => {
  const handshake = (token: string) =>
    GET(
      new Request(
        `https://support.example/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
      ),
    );

  it('answers the bare challenge to the right token', async () => {
    const response = await handshake('verify-me');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('1158201444');
    expect(response.headers.get('content-type')).toBe('text/plain');
  });

  it('refuses the wrong token', async () => {
    expect((await handshake('guess')).status).toBe(403);
  });

  it('says it is not configured rather than refusing, when there is no token', async () => {
    setTestEnv({ META_VERIFY_TOKEN: undefined });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await handshake('verify-me')).status).toBe(500);
  });
});

describe('a signed delivery', () => {
  it('is stored whole, under an id built from every wamid in the batch, and queued', async () => {
    const response = await deliver();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'queued' });
    expect(writes).toEqual([
      expect.objectContaining({
        provider: 'whatsapp',
        channel: 'whatsapp',
        providerEventId: 'e:wamid.E|m:wamid.M|m:wamid.Z|s:wamid.A:delivered',
        payload: BATCH,
        signatureVerified: true,
      }),
    ]);
    expect(conflictTargets).toEqual([[webhookEvents.provider, webhookEvents.providerEventId]]);
    expect(enqueue).toHaveBeenCalledWith(
      'process_webhook',
      { webhookEventId: 'event-1' },
      { priority: 10, dedupeKey: 'process_webhook:event-1' },
    );
  });

  it('keeps the signature as evidence and drops the credentials', async () => {
    await deliver();

    const headers = writes[0]!.headers as Record<string, string>;
    expect(headers['x-hub-signature-256']).toMatch(/^sha256=/);
    expect(headers).not.toHaveProperty('cookie');
    expect(headers).not.toHaveProperty('authorization');
  });

  /**
   * The signature covers the bytes Meta sent, which are not what
   * `JSON.stringify` would produce from the parsed object. A route verifying a
   * re-serialised body would refuse every real delivery.
   */
  it('verifies the bytes as sent, not the payload re-serialised', async () => {
    const raw = '{ "entry": [], "object": "whatsapp_business_account" }';

    const response = await deliver(raw, sign(raw));

    expect(response.status).toBe(200);
    expect(writes[0]).toMatchObject({ signatureVerified: true, payload: JSON.parse(raw) });
  });

  it('stores an empty batch under no id, so it cannot collide', async () => {
    const empty = { object: 'whatsapp_business_account', entry: [] };
    await deliver(empty);

    expect(writes[0]).toMatchObject({ providerEventId: null, signatureVerified: true });
  });

  it('keys a long batch on every wamid in it, not on the first few', async () => {
    const batchOf = (count: number) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: Array.from({ length: count }, (_, i) => ({
                  id: `wamid.HBgMMjAxMDAwMDAwMDAwFQIAEhgUM0E${String(i).padStart(16, '0')}AA==`,
                })),
              },
            },
          ],
        },
      ],
    });

    await deliver(batchOf(12));
    await deliver(batchOf(13));

    const [first, later] = writes.map((w) => w.providerEventId as string);
    expect(first!.length).toBeLessThanOrEqual(500);
    expect(later).not.toBe(first);
  });

  it('answers a redelivery 200, so Meta stops, and queues nothing', async () => {
    conflict = true;

    const response = await deliver();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'duplicate' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('an unsigned delivery', () => {
  it.each([
    ['a signature from another secret', () => deliver(BATCH, sign(JSON.stringify(BATCH), 'other'))],
    ['no signature', () => deliver(BATCH, null)],
  ])('with %s is stored as evidence under no id, refused, and not queued', async (_what, run) => {
    const response = await run();

    expect(response.status).toBe(403);
    expect(writes).toEqual([
      expect.objectContaining({ providerEventId: null, signatureVerified: false }),
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('is refused the same way when no app secret is configured', async () => {
    setTestEnv({ META_APP_SECRET: undefined });

    const response = await deliver();

    expect(response.status).toBe(403);
    expect(writes[0]).toMatchObject({ providerEventId: null, signatureVerified: false });
  });
});

it('refuses a body that is not JSON, and stores nothing', async () => {
  const response = await deliver('{not json', sign('{not json'));

  expect(response.status).toBe(400);
  expect(writes).toEqual([]);
});
