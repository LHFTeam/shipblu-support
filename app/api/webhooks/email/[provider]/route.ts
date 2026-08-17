import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { emailProvider } from '@/lib/email/providers';
import { enqueue } from '@/lib/queue';

export const dynamic = 'force-dynamic';

/**
 * Inbound email webhook.
 *
 * Persists the raw payload and returns immediately; the worker does the real
 * work. Three reasons this split matters:
 *
 *  - providers retry on a slow or failed response, so a heavy ingest here turns
 *    one email into several;
 *  - a stored payload can be replayed after a bug fix, instead of being lost;
 *  - the raw body plus its verification verdict is the audit trail when a
 *    customer insists they emailed us.
 *
 * A payload that fails signature verification is still stored — that is the
 * evidence of an attempted forgery — but is never queued for processing.
 */
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: providerName } = await context.params;

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    // Never persist the credential itself; we only record whether it checked out.
    if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'cookie') return;
    headers[key.toLowerCase()] = value;
  });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const provider = emailProvider();

  // Guard against a webhook pointed at the wrong driver, which would otherwise
  // fail signature checks in a confusing way.
  if (providerName !== provider.name) {
    return NextResponse.json(
      { error: `provider mismatch: configured as "${provider.name}"` },
      { status: 400 },
    );
  }

  const authHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    authHeaders[key.toLowerCase()] = value;
  });

  const signatureVerified = provider.verifySignature(rawBody, authHeaders);

  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: provider.name,
      channel: 'email',
      providerEventId: extractProviderEventId(payload),
      payload,
      headers,
      signatureVerified,
    })
    .onConflictDoNothing({
      target: [webhookEvents.provider, webhookEvents.providerEventId],
    })
    .returning({ id: webhookEvents.id });

  // Conflict means we already have this delivery; acknowledge so the provider
  // stops retrying, but do not queue it a second time.
  if (inserted.length === 0) {
    return NextResponse.json({ status: 'duplicate' }, { status: 200 });
  }

  const eventId = inserted[0]!.id;

  if (!signatureVerified) {
    console.warn(`[webhook:${provider.name}] stored unverified payload ${eventId}`);
    return NextResponse.json({ error: 'signature verification failed' }, { status: 401 });
  }

  await enqueue(
    'process_webhook',
    { webhookEventId: eventId },
    // Ahead of the default 100: a customer waiting on a reply beats bulk work.
    { priority: 10, dedupeKey: `process_webhook:${eventId}` },
  );

  return NextResponse.json({ status: 'queued', eventId }, { status: 200 });
}

/** Providers name this differently; used for delivery-level idempotency. */
function extractProviderEventId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  for (const key of ['MessageID', 'MessageId', 'message-id', 'id', 'event-id']) {
    const value = p[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * Providers verify an endpoint with a GET before enabling it, so this must
 * answer even though it carries no data.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}
