import { NextResponse } from 'next/server';
import { isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { allow, clientIp } from '@/lib/kb/rate-limit';
import { apiError } from '@/lib/myblu/errors';
import {
  identitySigningEnabled,
  parseClaim,
  parseInstallId,
  resolveIdentity,
  verifyClaim,
} from '@/lib/myblu/identity';
import { introspect } from '@/lib/myblu/platform';
import {
  contactFor,
  decorate,
  installChangedHands,
  issueSession,
  mobileHours,
  revokeSession,
} from '@/lib/myblu/session';
import { ShipbluApiError } from '@/lib/shipments/platform';
import { bearerFrom, handle, localeOf } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * Opens a support session for a signed-in myBlu user.
 *
 * The app sends the **platform** bearer it already holds; this endpoint asks
 * `api.shipblu.com` whether that token is live, and answers with a token of its
 * own that every other endpoint takes. Nothing after this re-introspects, which
 * is what keeps an outbound call off the path the app spends its time on.
 *
 * Rate limited by IP, and that limit is not decoration: this is an endpoint
 * anybody can call that makes an outbound request to the delivery platform, so
 * without it, it is a free amplifier aimed at `api.shipblu.com`.
 */
export async function POST(request: Request) {
  return handle(request, () => openSession(request));
}

async function openSession(request: Request): Promise<Response> {
  if (!allow(`myblu-session:${clientIp(request)}`, 30, 60_000)) {
    return apiError(request, 'rate_limited');
  }

  const bearer = bearerFrom(request);
  if (!bearer) return apiError(request, 'platform_token_invalid');

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return apiError(request, 'invalid_request');
  }

  const installId = parseInstallId(body.installId ?? body.install_id);
  if (!installId) return apiError(request, 'invalid_request');

  let introspection;
  try {
    introspection = await introspect(bearer);
  } catch (error) {
    if (error instanceof ShipbluApiError && error.status === 401) {
      // The one place a 401 is correct. The app clears its whole session on
      // this, which is right: the platform token really is dead.
      return apiError(request, 'platform_token_invalid');
    }

    // Everything else — a timeout, a 500, a DNS failure — is the platform
    // being unreachable, and must not be a 401. Signing every myBlu user out
    // of the app because `api.shipblu.com` had a bad minute would be a far
    // worse failure than the minute.
    console.error('[myblu:session] introspection failed', error);
    return apiError(request, 'platform_unavailable');
  }

  const claim = parseClaim(body);
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const signatureVerified = signature ? verifyClaim(claim, signature) : false;

  // A signature that does not verify is refused rather than quietly downgraded,
  // once there is a secret to check it against. The downgrade is the failure
  // mode worth designing against: a platform that starts signing with the wrong
  // secret — a rotation half-applied, staging's value in production — would
  // otherwise keep succeeding, every customer would silently drop to a
  // device-scoped history, and nothing anywhere would report it. Without a
  // secret there is nothing to check, so a signature is noise from an
  // integration pointed at the wrong environment and is ignored.
  if (signature && !signatureVerified && identitySigningEnabled()) {
    return apiError(request, 'platform_token_invalid');
  }

  const identity = resolveIdentity({
    profile: introspection.profile,
    subject: introspection.subject,
    claim,
    signatureVerified,
  });

  // This install last belonged to somebody else — a shared handset, or a second
  // account on the same phone. A fresh session rather than resuming: the
  // previous contact keeps its tickets and this person starts their own.
  const changedHands = await installChangedHands(installId, identity.subject);
  const scope = changedHands ? `${installId}:${identity.subject}` : installId;

  const contactId = await contactFor(identity, scope);
  await decorate(contactId, identity);

  const issued = await issueSession({
    contactId,
    installId: scope,
    identity,
    locale: localeOf(request),
    appVersion: request.headers.get('shipblu-app-version')?.slice(0, 40) ?? null,
    platform: request.headers.get('shipblu-platform')?.slice(0, 20) ?? null,
  });

  const hours = await mobileHours();
  const online = hours ? isWithinBusinessHours(hours) : false;

  return NextResponse.json({
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    // So the app can badge a thread honestly. False is not an error state: it
    // means the platform named nobody for this token, so support history is
    // scoped to this install until an agent merges the records.
    identityVerified: identity.verified,
    contact: { name: identity.name, email: identity.email, phone: identity.phone },
    online,
    opensAt: (!online && hours ? nextOpeningAt(hours) : null)?.toISOString() ?? null,
    timezone: hours?.timezone ?? null,
  });
}

/**
 * Ends a support session.
 *
 * The app calls this from its own `logout()`. Without it a device keeps a live
 * support session for up to seven days after the platform token is dropped —
 * which reaches only that person's own support history, but the one event where
 * we know it should end is worth not wasting.
 */
export async function DELETE(request: Request) {
  const token = bearerFrom(request);
  if (token) await revokeSession(token);

  // 204 whether or not anything was deleted: a logout that reports "no such
  // session" tells a caller which tokens exist, and the app has nothing useful
  // to do with the difference.
  return new Response(null, { status: 204 });
}
