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

/**
 * The three fields a number on the WhatsApp Business app adds, through the
 * route rather than `deliveryId` alone: what matters is the key the row is
 * stored under, because that is what the unique index answers "duplicate" on.
 * The shapes are Meta's own samples from the field references.
 */
describe('a signed delivery for a number on the WhatsApp Business app', () => {
  const coexistence = (field: string, value: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', time: 1739212624, changes: [{ field, value }] }],
  });
  const METADATA = { display_phone_number: '15550783881', phone_number_id: '106540352242922' };

  const HISTORY = coexistence('history', {
    messaging_product: 'whatsapp',
    metadata: METADATA,
    history: [
      {
        metadata: { phase: 0, chunk_order: 1, progress: 55 },
        threads: [
          {
            id: '16505551234',
            messages: [
              { from: '15550783881', id: 'wamid.OUT', timestamp: '1739230955', type: 'text' },
              { from: '16505551234', id: 'wamid.IN', timestamp: '1739230970', type: 'text' },
            ],
          },
          {
            id: '12125557890',
            messages: [
              { from: '15550783881', id: 'wamid.OTHER', timestamp: '1739230970', type: 'text' },
            ],
          },
        ],
      },
    ],
  });

  it('stores a history chunk under every message of every thread, and a redelivery as a duplicate', async () => {
    const response = await deliver(HISTORY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'queued' });
    expect(writes).toEqual([
      expect.objectContaining({
        providerEventId: 'hm:wamid.IN|hm:wamid.OTHER|hm:wamid.OUT',
        payload: HISTORY,
        signatureVerified: true,
      }),
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Meta's redelivery: the same bytes, so the same key — which the index has.
    conflict = true;
    const again = await deliver(HISTORY);

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate' });
    expect(writes[1]).toMatchObject({ providerEventId: writes[0]!.providerEventId });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('stores an address-book delivery under each contact, its action and its instant', async () => {
    const contact = (phone: string, action: string, timestamp: string) => ({
      type: 'contact',
      contact: { full_name: 'Pablo Morales', first_name: 'Pablo', phone_number: phone },
      action,
      metadata: { timestamp },
    });
    const sync = coexistence('smb_app_state_sync', {
      messaging_product: 'whatsapp',
      metadata: METADATA,
      state_sync: [
        contact('16505551234', 'add', '1739321024'),
        contact('12125557890', 'remove', '1739321100'),
      ],
    });

    const response = await deliver(sync);

    expect(await response.json()).toEqual({ status: 'queued' });
    expect(writes).toEqual([
      expect.objectContaining({
        providerEventId: 'c:12125557890:remove:1739321100|c:16505551234:add:1739321024',
        signatureVerified: true,
      }),
    ]);
  });

  /**
   * No key, so nothing collides: the same disconnect body can arrive again
   * after a reconnect, and the second must be processed. The handler is the
   * idempotent part (`applyWhatsAppAccountUpdate`).
   */
  it('stores an account update under no id, and queues the same body twice', async () => {
    const update = coexistence('account_update', {
      phone_number: '15550783881',
      event: 'PARTNER_REMOVED',
      disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
    });

    await deliver(update);
    await deliver(update);

    expect(writes).toEqual([
      expect.objectContaining({ providerEventId: null, signatureVerified: true }),
      expect.objectContaining({ providerEventId: null, signatureVerified: true }),
    ]);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  // A null where a chunk belongs used to throw in the key, before the insert:
  // a 500 with nothing stored, and every redelivery the same.
  it('stores a history holding a null chunk under the chunk beside it', async () => {
    const junk = coexistence('history', {
      metadata: METADATA,
      history: [null, { threads: [{ id: '16505551234', messages: [{ id: 'wamid.KEPT' }] }] }],
    });

    const response = await deliver(junk);

    expect(response.status).toBe(200);
    expect(writes).toEqual([expect.objectContaining({ providerEventId: 'hm:wamid.KEPT' })]);
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

  // Review on #263: the delivery id is read off the payload, which nothing has
  // checked yet. An unsigned body that parses but is not a batch must still be
  // filed as evidence and refused, not crash the route before the row is written.
  it.each([
    ['null', 'null'],
    ['an entry that is not a list', '{"entry":5}'],
  ])('with %s for a body is still stored as evidence and refused', async (_what, body) => {
    const response = await deliver(body, null);

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
