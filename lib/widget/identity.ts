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
 * Whether a signature over this identity could vouch for anybody.
 *
 * The signed claim names an account id and an email and nothing else, so an
 * identity carrying neither — a phone alone, an account name alone — signs the
 * constant `"|"`. One HMAC of that, which any integrator's backend mints for its
 * first phone-only user, is then a valid signature for every phone number there
 * is, and `identityKey` falls back to the phone, so the contact would be marked
 * verified under a key the signature never mentioned. Such a signature proves
 * only that somebody once held the secret, not who this visitor is.
 *
 * Unverified rather than refused: the signature is not *wrong*, it says nothing,
 * and a deployed integration that signs every user it has must not start
 * failing with a 401 for the ones without an email. A phone-keyed integration
 * that needs the phone vouched for gets a second accepted claim form, added
 * beside this one, rather than a change to what this one covers.
 */
export function claimNamesSomebody(identity: WidgetIdentity): boolean {
  return Boolean(identity.accountId || identity.email);
}

/**
 * Whether the platform, rather than the browser, is asserting this identity.
 *
 * False when no secret is configured: an integration that has not been given
 * one cannot be producing real signatures, and treating an unverifiable
 * signature as valid would make the whole mechanism decorative. False, too, for
 * an identity whose claim names nobody (`claimNamesSomebody`) — the one place
 * that rule is applied, so the second claim form a phone-keyed integration
 * needs changes it here and nowhere else.
 *
 * Private, as is `identitySigningEnabled`: `judgeSignature` is the one public
 * decision. A caller holding these two would rebuild the route's old
 * "signed, not verified, signing on → 401", which refuses a claim naming nobody
 * that this module answers as unverified.
 */
function verifyIdentity(identity: WidgetIdentity, signature: string): boolean {
  const secret = env().WIDGET_IDENTITY_SECRET;
  const supplied = signature.trim().toLowerCase();
  if (!secret || !supplied || !claimNamesSomebody(identity)) return false;

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
 * notices for a month. The one exception is a claim that names nobody, which
 * no signature could have vouched for: `judgeSignature` answers it unverified
 * on purpose, and a route "fixed" back to refusing it breaks every signed
 * integration's users who have no email.
 */
function identitySigningEnabled(): boolean {
  return Boolean(env().WIDGET_IDENTITY_SECRET);
}

/**
 * Whether the host's raw identity carried an account id or an email that the
 * parser threw away — an address `looksLikeEmail` refuses, an account id that
 * was nothing but punctuation.
 *
 * The parsed identity then names nobody, but the host's backend signed the raw
 * value (`|nour@merchant`), so its signature is wrong rather than empty. That
 * was a 401 before claims naming nobody stopped being refused, and it stays
 * one: the integration is broken, and the 401 is what makes that visible.
 */
function claimLostInParsing(raw: unknown, identity: WidgetIdentity): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const input = raw as Record<string, unknown>;
  const given = (value: unknown) =>
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  return (
    (!identity.email && given(input.email)) ||
    (!identity.accountId && given(input.accountId ?? input.account_id))
  );
}

export type SignatureVerdict = 'verified' | 'unverified' | 'refused';

/**
 * What a host page's signature makes of the identity it came with — the one
 * decision `/api/widget/identify` acts on, and the only one this module
 * exports.
 *
 * `refused` (a 401) for a signature that fails to verify while a secret is
 * configured (`identitySigningEnabled`), except over a claim that names nobody,
 * which is `unverified` whether or not it matches, because it could not have
 * proved anything either way — unless the host named an account id or email
 * the parser dropped (`claimLostInParsing`). `raw` is the identity as the host
 * sent it, before `parseIdentity`, for that last question alone.
 *
 * The signature is trimmed here, so the answer does not depend on whether the
 * caller trimmed it: a blank one is no signature.
 */
export function judgeSignature(
  identity: WidgetIdentity,
  signature: string,
  raw: unknown,
): SignatureVerdict {
  if (!signature.trim()) return 'unverified';
  if (verifyIdentity(identity, signature)) return 'verified';
  if (!identitySigningEnabled()) return 'unverified';
  if (claimNamesSomebody(identity) || claimLostInParsing(raw, identity)) return 'refused';
  return 'unverified';
}
