import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { emailProvider } from '@/lib/email/providers';
import { enqueue } from '@/lib/queue';
import { logIncomingWebhook } from '@/lib/webhooks/log';

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

  // Before verification and before parsing — see the note on the Meta endpoint.
  // Postmark authenticates with Basic Auth, so the logger redacts the
  // Authorization header rather than printing EMAIL_WEBHOOK_SECRET.
  logIncomingWebhook({
    source: `email:${providerName}`,
    method: request.method,
    url: request.url,
    headers: request.headers,
    rawBody,
  });

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

  // Verification needs the credential, so it reads the unredacted headers —
  // separate from the map persisted above, which deliberately drops it.
  const authHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    authHeaders[key.toLowerCase()] = value;
  });

  const signatureVerified = provider.verifySignature(rawBody, authHeaders);

  // An unverified payload is stored as evidence but never under a delivery id,
  // as on the WhatsApp and Meta endpoints. Stored under the id it claims, it
  // would let anyone who learns a MessageID post an unsigned payload naming it,
  // take the slot in the unique index first, and have the genuine delivery
  // dropped as a duplicate.
  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: provider.name,
      channel: 'email',
      providerEventId: signatureVerified ? extractProviderEventId(payload) : null,
      payload,
      headers,
      signatureVerified,
    })
    .onConflictDoNothing({
      target: [webhookEvents.provider, webhookEvents.providerEventId],
    })
    .returning({ id: webhookEvents.id });

  // Refused before the duplicate check, never after it. Postmark retries any
  // answer but a 200 or a 403, ten times over about ten hours, so with a wrong
  // EMAIL_WEBHOOK_SECRET its retry must hear the same refusal as the first
  // attempt: a 200 `duplicate` here would mark the message delivered, and the
  // email would be lost even after the secret was corrected.
  //
  // 401 rather than the 403 the WhatsApp and Meta endpoints answer, for the
  // same reason: a 403 tells Postmark to stop retrying, and those retries are
  // what recover a real email once a misconfigured secret is fixed. A forger's
  // retries cost only an evidence row each, under a null id that can collide
  // with nothing.
  if (!signatureVerified) {
    console.warn(`[webhook:${provider.name}] stored unverified payload ${inserted[0]?.id}`);
    return NextResponse.json({ error: 'signature verification failed' }, { status: 401 });
  }

  // Conflict means we already have this delivery; acknowledge so the provider
  // stops retrying, but do not queue it a second time.
  if (inserted.length === 0) {
    return NextResponse.json({ status: 'duplicate' }, { status: 200 });
  }

  const eventId = inserted[0]!.id;

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
