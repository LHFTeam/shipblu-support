import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { metaAppSecret, metaVerifyToken } from '@/lib/env';
import type { MetaWebhookPayload } from '@/lib/meta/types';
import { enqueue } from '@/lib/queue';
import { SIGNATURE_HEADER, verifyChallenge, verifySignature } from '@/lib/whatsapp/verify';

export const dynamic = 'force-dynamic';

/**
 * Facebook and Instagram webhook.
 *
 * One endpoint for both, because Meta delivers them through one app
 * subscription and distinguishes them only by the `object` field. Splitting
 * them would mean two URLs to register, two secrets to keep in step, and the
 * same code twice.
 *
 * Same discipline as the WhatsApp endpoint: persist the raw payload, enqueue,
 * return 200 fast. Nothing here parses a message or calls the Graph API — Meta
 * retries the entire batch on a slow or failed response, and repeatedly failing
 * deliveries eventually get the subscription disabled.
 *
 * Signature verification reuses `lib/whatsapp/verify`, which is Meta's
 * X-Hub-Signature-256 scheme rather than anything WhatsApp-specific.
 */

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = metaVerifyToken();

  if (!token) {
    console.error('[webhook:meta] META_VERIFY_TOKEN is not configured');
    return new NextResponse('not configured', { status: 500 });
  }

  const challenge = verifyChallenge(params, token);
  if (challenge === null) return new NextResponse('verification failed', { status: 403 });

  return new NextResponse(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

export async function POST(request: Request) {
  const appSecret = metaAppSecret();

  // Raw bytes: the signature covers exactly what Meta sent, and re-serialising
  // parsed JSON produces a different string.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
  }

  const signatureVerified = appSecret
    ? verifySignature(rawBody, request.headers.get(SIGNATURE_HEADER), appSecret)
    : false;

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const channel = payload.object === 'instagram' ? 'instagram' : 'facebook';

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === 'authorization' || name === 'cookie') return;
    headers[name] = value;
  });

  // An unverified payload is stored as evidence but *never* under a delivery
  // id. Sharing the id with the genuine delivery would let anyone who can see a
  // comment id — they are public on Facebook — post an unsigned payload naming
  // it, take the id first, and have the real event arrive later and be dropped
  // as a duplicate. The forgery is filed for inspection; it cannot pre-empt.
  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: 'meta',
      channel,
      providerEventId: signatureVerified ? deliveryId(payload) : null,
      payload,
      headers,
      signatureVerified,
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning({ id: webhookEvents.id });

  if (!signatureVerified) {
    console.warn(
      `[webhook:meta] stored unverified payload from ${headers['x-forwarded-for'] ?? 'an unknown source'}`,
    );
    // 403 rather than 200: an unsigned payload is either a misconfigured app
    // secret or a forgery, and both should be loud.
    return NextResponse.json({ error: 'signature verification failed' }, { status: 403 });
  }

  if (inserted.length === 0) {
    // Already have this delivery. 200 so Meta stops retrying.
    return NextResponse.json({ status: 'duplicate' }, { status: 200 });
  }

  const eventId = inserted[0]!.id;

  await enqueue(
    'process_webhook',
    { webhookEventId: eventId },
    { priority: 10, dedupeKey: `process_webhook:${eventId}` },
  );

  return NextResponse.json({ status: 'queued' }, { status: 200 });
}

/**
 * Delivery-level idempotency key, derived from the batch contents.
 *
 * Meta sends no event id of its own. Message ids and comment ids are stable
 * across redeliveries of the same batch and differ between distinct ones, which
 * is exactly the property needed. Null for a contentless delivery, because the
 * unique index treats nulls as distinct and storing them separately is better
 * than colliding unrelated empty batches onto one row.
 */
function deliveryId(payload: MetaWebhookPayload): string | null {
  const parts: string[] = [];

  for (const entry of payload.entry ?? []) {
    for (const event of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      if (event.message?.mid) parts.push(`m:${event.message.mid}`);
      // Receipts carry no id of their own; the watermark plus the sender is
      // what makes one delivery distinguishable from the next.
      if (event.delivery?.watermark)
        parts.push(`d:${event.sender?.id}:${event.delivery.watermark}`);
      if (event.read?.watermark) parts.push(`r:${event.sender?.id}:${event.read.watermark}`);
    }

    for (const change of entry.changes ?? []) {
      const value = change.value;
      const commentId = value?.comment_id ?? value?.id;
      if (commentId) parts.push(`c:${commentId}:${value?.verb ?? 'add'}`);
    }
  }

  if (parts.length === 0) return null;
  return parts.sort().join('|').slice(0, 500);
}
