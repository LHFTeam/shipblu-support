import { createHmac } from 'node:crypto';
import { safeEqual } from '@/lib/auth/tokens';
import { env } from '@/lib/env';
import type { WidgetIdentity } from './identity-parse';

/**
 * Who the page carrying the widget says its visitor is.
 *
 * A logged-in dashboard knows exactly who is typing, and re-asking them for a
 * name and an email is the thing that makes an embedded chat feel like a form.
 * So the host page may tell us — the same contract Freshchat's
 * `fcWidgetMessengerConfig` had, which is what this replaces.
 *
 * **It arrives from a browser, so by itself it is a claim and not a fact.**
 * Anyone can open devtools and call `identify()` with somebody else's address.
 * Two things follow, and they are the whole design of this module:
 *
 *  - An unverified claim may only *decorate* the visitor's own contact — the
 *    name, email and phone an agent reads. It never adopts an existing contact,
 *    so it cannot be used to read another customer's history, and it never
 *    writes `contact_shipping_accounts`, which is a claim about whose account
 *    a person may speak for.
 *  - A claim carrying a valid HMAC of `accountId|email`, computed by the host's
 *    *backend* with `WIDGET_IDENTITY_SECRET`, is a fact. That is the one that
 *    may link the person to their shipping account.
 *
 * The signature deliberately covers the identifying half only. Name, phone and
 * the free-form fields are decoration — nothing keys off them — and including
 * them would mean a merchant who changes their display name gets a signature
 * mismatch and silently stops being identified at all.
 */

export { parseIdentity, type WidgetIdentity } from './identity-parse';

/**
 * What makes this identity *this person*, for the purpose of noticing that the
 * browser now belongs to somebody else.
 *
 * The account first: on a shared dashboard machine two colleagues of the same
 * merchant are the same customer for support purposes, and starting a new
 * conversation for each of them would split one account's history in two.
 *
 * This is the server's key, and it stays account-first. Whether the person at
 * the browser changed since a token was vouched for — which a host page's
 * `clear()` promises a clean slate for — is the frame's question, asked before
 * it reopens anything, in `lib/widget/person.ts`.
 */
export function identityKey(identity: WidgetIdentity): string | null {
  if (identity.accountId) return `account:${identity.accountId}`;
  if (identity.email) return `email:${identity.email}`;
  if (identity.phone) return `phone:${identity.phone}`;
  return null;
}

/**
 * The string the host's backend signs. Documented in
 * `docs/embedding-the-widget.md`, so changing it breaks a deployed integration
 * — add a second accepted form rather than editing this one.
 */
export function signedClaim(identity: WidgetIdentity): string {
  return `${identity.accountId ?? ''}|${identity.email ?? ''}`;
}

/**
 * Whether the platform, rather than the browser, is asserting this identity.
 *
 * False when no secret is configured: an integration that has not been given
 * one cannot be producing real signatures, and treating an unverifiable
 * signature as valid would make the whole mechanism decorative.
 */
export function verifyIdentity(identity: WidgetIdentity, signature: unknown): boolean {
  const secret = env().WIDGET_IDENTITY_SECRET;
  const supplied = typeof signature === 'string' ? signature.trim().toLowerCase() : '';
  if (!secret || !supplied) return false;

  const expected = createHmac('sha256', secret).update(signedClaim(identity)).digest('hex');
  return safeEqual(expected, supplied);
}

/**
 * Whether a signature that fails to verify should be treated as an error.
 *
 * Without a secret there is nothing to check against, so a signature is noise
 * from an integration pointed at the wrong environment and the identity is
 * simply unverified. With one, a bad signature is either tampering or a broken
 * deployment, and both deserve a 401 rather than a quiet downgrade to
 * unverified — a downgrade is how a signing integration breaks and nobody
 * notices for a month.
 */
export function identitySigningEnabled(): boolean {
  return Boolean(env().WIDGET_IDENTITY_SECRET);
}
