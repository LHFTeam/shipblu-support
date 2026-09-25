import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The inbound email webhook's two decisions: which delivery id a stored payload
 * carries, and what Postmark is told.
 *
 * The database and the queue are replaced by recorders, because the questions
 * here are about what the route asks them for — the `provider_event_id` it
 * writes, whether it enqueues — rather than about Postgres. The unique index on
 * `(provider, provider_event_id)` is simulated by `conflict`: when set, the
 * insert returns no row, which is exactly what `onConflictDoNothing` answers.
 */

const writes: Record<string, unknown>[] = [];
let conflict = false;

vi.mock('@/db/client', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: async () => (conflict ? [] : [{ id: 'event-1' }]),
          }),
        };
      },
    }),
  },
}));

const enqueue = vi.fn(async () => {});
vi.mock('@/lib/queue', () => ({ enqueue }));

let verified = true;
vi.mock('@/lib/email/providers', () => ({
  emailProvider: () => ({
    name: 'postmark',
    verifySignature: () =>
      verified ? { verified: true } : { verified: false, reason: 'did not match' },
  }),
}));

vi.mock('@/lib/webhooks/log', () => ({ logIncomingWebhook: () => {} }));

const { POST } = await import('./route');

const MESSAGE_ID = '0a1b2c3d-real-delivery';

function deliver() {
  const request = new Request('https://support.example/api/webhooks/email/postmark', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic credential' },
    body: JSON.stringify({ MessageID: MESSAGE_ID, Subject: 'Where is my parcel?' }),
  });
  return POST(request, { params: Promise.resolve({ provider: 'postmark' }) });
}

beforeEach(() => {
  writes.length = 0;
  conflict = false;
  verified = true;
  enqueue.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/webhooks/email/[provider]', () => {
  it('stores a verified delivery under its message id and queues it', async () => {
    const response = await deliver();

    expect(response.status).toBe(200);
    expect(writes[0]?.providerEventId).toBe(MESSAGE_ID);
    expect(writes[0]?.signatureVerified).toBe(true);
    expect(writes[0]?.error).toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a verified redelivery as a duplicate without queueing it again', async () => {
    conflict = true;
    const response = await deliver();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'duplicate' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  /**
   * The forgery this closes: anyone who learns a message id posts an unsigned
   * payload naming it. Stored under that id, it takes the slot first, and the
   * genuine delivery arrives to find the unique index already holding it — so
   * it is dropped as a duplicate and the customer's email never becomes a
   * ticket. WhatsApp and Meta have refused this since they were written.
   */
  it('stores an unverified payload as evidence but never under a delivery id', async () => {
    verified = false;
    const response = await deliver();

    expect(writes[0]?.providerEventId).toBeNull();
    expect(writes[0]?.signatureVerified).toBe(false);
    expect(writes[0]?.error).toBe('did not match');
    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  /**
   * The misconfiguration half of the same bug. With the wrong
   * EMAIL_WEBHOOK_SECRET, Postmark's first attempt is stored unverified and
   * answered 401, and Postmark retries. If that retry is then answered 200
   * `duplicate` — which is what checking the index before the signature did —
   * Postmark marks the message delivered and stops, so the email is lost even
   * after the secret is corrected. An unverified delivery is refused whatever
   * the index says.
   */
  it('never tells Postmark an unverified delivery arrived, even when the index already holds one', async () => {
    verified = false;
    conflict = true;
    const response = await deliver();

    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never persists the credential it verified with', async () => {
    await deliver();

    const headers = writes[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });
});
