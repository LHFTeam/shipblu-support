import { NextResponse } from 'next/server';
import { emailProvider } from '@/lib/email/providers';
import { queueDelivery, readDelivery, storeDelivery, storedHeaders } from '@/lib/webhooks/receive';
import { logger } from '@/lib/log';

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

  // Logged before verification and before parsing — see the note on the Meta
  // endpoint. Postmark authenticates with Basic Auth, so the logger redacts the
  // Authorization header rather than printing EMAIL_WEBHOOK_SECRET.
  const rawBody = await readDelivery(request, `email:${providerName}`);
  if (rawBody === null) {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
  }

  // Never persist the credential itself; we only record whether it checked out.
  const headers = storedHeaders(request.headers);

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
  // separate from the map stored above, which deliberately drops it.
  const authHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    authHeaders[key.toLowerCase()] = value;
  });

  const verdict = provider.verifySignature(rawBody, authHeaders);
  const signatureVerified = verdict.verified;

  // Stored whether or not it verified. An unverified one goes in under no
  // delivery id, which `storeDelivery` enforces and explains.
  const eventId = await storeDelivery({
    provider: provider.name,
    channel: 'email',
    deliveryId: () => extractProviderEventId(payload),
    payload,
    headers,
    signatureVerified,
    // Why it was refused, on the row: a missing secret and a forgery both
    // arrive as unverified, and the console line that tells them apart is
    // gone once Render's log retention passes it.
    error: verdict.verified ? null : verdict.reason,
  });

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
  //
  // The price is paid in storage during a misconfiguration. Each of those ten
  // retries is its own row now, where the index used to swallow them, and
  // Postmark's inbound JSON carries attachments inline as base64 — so one email
  // with a 10 MB attachment can leave about 110 MB of evidence behind while the
  // secret is wrong. `cleanup` expires unverified rows on their own clock
  // (UNVERIFIED_WEBHOOK_DAYS); a jump in `webhook_events` during an incident is
  // this, not a leak.
  if (!signatureVerified) {
    logger(`webhook:${provider.name}`).warn(`stored unverified payload ${eventId}`);
    return NextResponse.json({ error: 'signature verification failed' }, { status: 401 });
  }

  // Conflict means we already have this delivery; acknowledge so the provider
  // stops retrying, but do not queue it a second time.
  if (eventId === null) {
    return NextResponse.json({ status: 'duplicate' }, { status: 200 });
  }

  await queueDelivery(eventId);

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
