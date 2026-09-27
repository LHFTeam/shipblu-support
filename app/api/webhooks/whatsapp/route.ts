import { NextResponse } from 'next/server';
import { metaAppSecret, metaVerifyToken } from '@/lib/env';
import { boundedDeliveryKey } from '@/lib/webhooks/delivery-key';
import { queueDelivery, readDelivery, storeDelivery, storedHeaders } from '@/lib/webhooks/receive';
import { SIGNATURE_HEADER, verifyChallenge, verifySignature } from '@/lib/whatsapp/verify';
import type { WhatsAppWebhookPayload } from '@/lib/whatsapp/types';

export const dynamic = 'force-dynamic';

/**
 * Meta Cloud API webhook.
 *
 * Same shape as the email webhook — persist, enqueue, return — but Meta is far
 * less forgiving: it expects a 200 within seconds, retries the entire batch on
 * anything else, and repeatedly failing deliveries eventually gets the
 * subscription disabled. So nothing here parses messages, touches storage, or
 * calls the Graph API.
 */

/** Meta's subscription handshake. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = metaVerifyToken();

  if (!token) {
    console.error('[webhook:whatsapp] META_VERIFY_TOKEN is not configured');
    return new NextResponse('not configured', { status: 500 });
  }

  const challenge = verifyChallenge(params, token);
  if (challenge === null) {
    return new NextResponse('verification failed', { status: 403 });
  }

  // Meta requires the bare challenge string, not JSON.
  return new NextResponse(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

export async function POST(request: Request) {
  const appSecret = metaAppSecret();

  const rawBody = await readDelivery(request, 'whatsapp');
  if (rawBody === null) {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
  }

  const signatureVerified = appSecret
    ? verifySignature(rawBody, request.headers.get(SIGNATURE_HEADER), appSecret)
    : false;

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const eventId = await storeDelivery({
    provider: 'whatsapp',
    channel: 'whatsapp',
    deliveryId: () => deliveryId(payload),
    payload,
    headers: storedHeaders(request.headers),
    signatureVerified,
  });

  if (!signatureVerified) {
    console.warn('[webhook:whatsapp] stored an unverified payload');
    // 403, not 200: an unsigned payload is either a misconfigured app secret or
    // a forgery, and both should be loud.
    return NextResponse.json({ error: 'signature verification failed' }, { status: 403 });
  }

  if (eventId === null) {
    // Already have this delivery. 200 so Meta stops retrying.
    return NextResponse.json({ status: 'duplicate' }, { status: 200 });
  }

  await queueDelivery(eventId);

  return NextResponse.json({ status: 'queued' }, { status: 200 });
}

/**
 * Delivery-level idempotency key.
 *
 * Meta sends no event id of its own, so one is derived from the batch contents:
 * the wamids of every message, echo and status in it, which is stable across
 * redeliveries of the same batch and differs between distinct ones. Returning
 * null for an empty batch is deliberate — the unique index treats nulls as
 * distinct, so contentless deliveries are stored rather than colliding. A
 * batch too long for the column is hashed whole rather than truncated — see
 * `boundedDeliveryKey`.
 */
function deliveryId(payload: WhatsAppWebhookPayload): string | null {
  const parts: string[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.id) parts.push(`m:${message.id}`);
      }
      for (const echo of change.value?.message_echoes ?? []) {
        if (echo.id) parts.push(`e:${echo.id}`);
      }
      for (const status of change.value?.statuses ?? []) {
        if (status.id) parts.push(`s:${status.id}:${status.status}`);
      }
    }
  }

  if (parts.length === 0) return null;
  return boundedDeliveryKey(parts.sort().join('|'));
}
