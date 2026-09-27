import { NextResponse } from 'next/server';
import { instagramAppSecrets, metaAppSecret, metaVerifyToken } from '@/lib/env';
import { deliveryId } from '@/lib/meta/delivery';
import {
  deliveryEnvelope,
  noteVerifyingSecret,
  signingCandidates,
  unverifiedReason,
} from '@/lib/meta/signing';
import type { MetaWebhookPayload } from '@/lib/meta/types';
import { queueDelivery, readDelivery, storeDelivery, storedHeaders } from '@/lib/webhooks/receive';
import { SIGNATURE_HEADER, verifyChallenge, verifySignature } from '@/lib/whatsapp/verify';

export const dynamic = 'force-dynamic';

/**
 * Facebook and Instagram webhook.
 *
 * One endpoint for both, because Meta delivers them through one app
 * subscription and distinguishes them only by the `object` field. Splitting
 * them would mean two URLs to register and the same code twice.
 *
 * One endpoint does not mean one credential, though, and that is the trap. This
 * Instagram account is connected **twice** — through its Facebook Page and
 * directly through Instagram Login — and the two setups sign with different app
 * secrets while sending byte-identical bodies. Which secrets can have signed a
 * delivery is decided by `lib/meta/signing.ts` from the object in the body, and
 * *which one actually did* is the only thing that says which connection a
 * delivery came in on. It is recorded on the row, because it is knowable here
 * and nowhere downstream.
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
  // Logged before verification and before parsing, so a delivery this endpoint
  // is about to reject — bad signature, unreadable JSON, duplicate id — is still
  // seen. Off unless LOG_ALL_INCOMING_WEBHOOKS is true.
  const rawBody = await readDelivery(request, 'meta');
  if (rawBody === null) {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
  }

  // Parsed before the signature is checked, which the body being *read* rather
  // than rewritten makes safe. It is the payload's own `object` that says which
  // app secret can have signed it — an Instagram account connected through
  // Instagram Login is signed with the Instagram app secret, not the app's.
  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const instagram = instagramAppSecrets();
  const candidates = signingCandidates(payload.object, {
    appSecret: metaAppSecret(),
    instagramAppSecret: instagram.current,
    legacyInstagramAppSecret: instagram.legacy,
  });

  const signature = request.headers.get(SIGNATURE_HEADER);
  const matched =
    candidates.find((candidate) => verifySignature(rawBody, signature, candidate.secret)) ?? null;
  const signatureVerified = matched !== null;

  // Which credential signed which channel, said once per combination. Both are
  // in use here: the same Instagram account is connected through its Facebook
  // Page and directly through Instagram Login, the two sign with different
  // secrets, and the App Review permissions differ between them.
  if (matched) noteVerifyingSecret(payload.object, matched, deliveryEnvelope(payload));

  const channel = payload.object === 'instagram' ? 'instagram' : 'facebook';

  const headers = storedHeaders(request.headers);

  const eventId = await storeDelivery({
    provider: 'meta',
    channel,
    deliveryId: () => (matched ? deliveryId(payload, matched.connection) : null),
    connection: matched?.connection ?? null,
    payload,
    headers,
    signatureVerified,
    // Why it was rejected, on the row itself. Without this a wrong secret and
    // a forgery are the same unexplained `false`, and the only place the
    // difference appeared was a log line nobody was reading: the Instagram
    // app secret going unset cost thirteen hours and 2,309 dropped
    // deliveries before anybody looked.
    error: signatureVerified ? null : unverifiedReason(candidates),
  });

  if (!signatureVerified) {
    console.warn(
      `[webhook:meta] stored unverified ${payload.object ?? 'unknown'} payload from ` +
        `${headers['x-forwarded-for'] ?? 'an unknown source'}: ${unverifiedReason(candidates)}`,
    );
    // 403 rather than 200: an unsigned payload is either a misconfigured app
    // secret or a forgery, and both should be loud.
    return NextResponse.json({ error: 'signature verification failed' }, { status: 403 });
  }

  if (eventId === null) {
    // Already have this delivery. 200 so Meta stops retrying.
    //
    // Said out loud, because a silent drop here is indistinguishable from a
    // delivery that never arrived — and the two have opposite fixes. The
    // dashboard's "Send to Server" button is where this bites: it posts a
    // byte-identical sample every time, so `deliveryId` returns the same key on
    // every press and only the *first* one in the life of the table ever
    // reaches a ticket. Meta reports "successfully sent" for all of them, which
    // reads as a broken pipeline. It cost an afternoon of looking at the parser
    // for a comment the parser had already handled correctly the day before
    // (§6.30). One line naming the key that collided answers it in a log search.
    console.log(
      `[webhook:meta] duplicate ${payload.object ?? 'unknown'} delivery on ` +
        `${matched.connection}, already stored as ${deliveryId(payload, matched.connection)} ` +
        `— not re-queued`,
    );
    return NextResponse.json({ status: 'duplicate' }, { status: 200 });
  }

  await queueDelivery(eventId);

  return NextResponse.json({ status: 'queued' }, { status: 200 });
}
