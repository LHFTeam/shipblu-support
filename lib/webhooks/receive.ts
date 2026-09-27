import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { enqueue } from '@/lib/queue';
import { logIncomingWebhook } from './log';

/**
 * The steps every webhook endpoint takes the same way: read the body, record
 * the headers, store the delivery, queue it.
 *
 * What differs stays in each route, in plain view: how a delivery is verified
 * (one secret, two Instagram app secrets, a provider driver), which check runs
 * first, and what status code each outcome answers. Those are the decisions a
 * reviewer has to see beside each other, and each one already cost a customer
 * channel when it was wrong — the email endpoint answers 401 where the Meta
 * ones answer 403, for a reason written beside it. Hiding them behind one
 * `receive()` would make the three routes read alike exactly where they must
 * not.
 */

/**
 * The body as the exact bytes the provider sent, or null when it cannot be read.
 *
 * Text, not `json()`: the signature covers those bytes, and re-serialising a
 * parsed object produces a different string. Logged here, before verification
 * and before parsing, so a delivery the route is about to reject is still seen —
 * see `lib/webhooks/log.ts`.
 */
export async function readDelivery(request: Request, source: string): Promise<string | null> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return null;
  }

  logIncomingWebhook({
    source,
    method: request.method,
    url: request.url,
    headers: request.headers,
    rawBody,
  });

  return rawBody;
}

/**
 * The headers as they are stored on the row, lower-cased.
 *
 * The signature header is kept, because it is the evidence. The credentials are
 * not: Postmark sends `EMAIL_WEBHOOK_SECRET` as Basic Auth on every delivery.
 * Verification that needs the credential reads the request's own headers.
 */
export function storedHeaders(headers: Headers): Record<string, string> {
  const stored: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === 'authorization' || name === 'cookie') return;
    stored[name] = value;
  });
  return stored;
}

type Delivery = Pick<
  typeof webhookEvents.$inferInsert,
  'provider' | 'channel' | 'connection' | 'payload' | 'headers' | 'error'
> & {
  signatureVerified: boolean;
  /**
   * The provider's delivery id, read only when the signature verified.
   *
   * A function rather than a value because reading it walks the payload, and
   * until the signature checks out the payload is whatever anybody posted: an
   * unsigned `null` that parses as JSON crashed the WhatsApp route before its
   * evidence row was written (review on #263). Called here, only a verified
   * body is ever read for its id, whichever route is storing it.
   */
  deliveryId: () => string | null;
};

/**
 * Stores a delivery, verified or not, and returns its row id — or null when a
 * verified delivery with the same id is already stored.
 *
 * An unverified payload is stored as evidence but never under its delivery id,
 * and that rule is enforced here rather than left to each route. Stored under
 * the id it claims, it would let anyone who learns one — a wamid, a comment id,
 * which is public on Facebook, a MessageID — post an unsigned payload naming
 * it, take the slot in the unique index first, and have the genuine delivery
 * dropped as a duplicate. With a null id it collides with nothing.
 */
export async function storeDelivery({
  deliveryId,
  signatureVerified,
  ...values
}: Delivery): Promise<string | null> {
  const inserted = await db
    .insert(webhookEvents)
    .values({
      ...values,
      providerEventId: signatureVerified ? deliveryId() : null,
      signatureVerified,
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning({ id: webhookEvents.id });

  return inserted[0]?.id ?? null;
}

/** Queues a stored, verified delivery for the worker. */
export async function queueDelivery(webhookEventId: string): Promise<void> {
  await enqueue(
    'process_webhook',
    { webhookEventId },
    // Ahead of the default 100: a customer waiting on a reply beats bulk work.
    { priority: 10, dedupeKey: `process_webhook:${webhookEventId}` },
  );
}
