import { createHmac } from 'node:crypto';
import { looksLikeEmail, normaliseEmail, normalisePhone } from '@/lib/auth/normalise';
import { safeEqual } from '@/lib/auth/tokens';
import { env } from '@/lib/env';

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

export type WidgetIdentity = {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** The merchant's account number on the shipping platform, if the host knows it. */
  accountId: string | null;
  accountName: string | null;
  /** Anything else the host chose to send, flattened to strings. */
  fields: Record<string, string>;
};

/** Long enough for a real value, short enough that nobody stores a document here. */
const MAX_VALUE = 200;
const MAX_FIELDS = 20;

export function parseIdentity(raw: unknown): WidgetIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  /*
   * `name`, or first and last joined. Both shapes because a dashboard holds the
   * two halves separately far more often than it holds the whole — the
   * Freshchat config this replaces sent `firstName` and `lastName`.
   */
  const joined = [text(input.firstName), text(input.lastName)]
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, MAX_VALUE);
  const name = text(input.name) ?? (joined || null);

  const rawEmail = text(input.email);
  const email = rawEmail && looksLikeEmail(rawEmail) ? normaliseEmail(rawEmail) : null;

  // Digits only, and only if there are enough of them to be a number rather
  // than an extension somebody pasted.
  const digits = normalisePhone(text(input.phone) ?? '');
  const phone = digits.length >= 6 && digits.length <= 20 ? digits : null;

  const accountId = identifier(input.accountId ?? input.account_id);
  const accountName = text(input.accountName ?? input.account_name);

  const identity: WidgetIdentity = {
    name,
    email,
    phone,
    accountId,
    accountName,
    fields: extraFields(input.meta ?? input.fields),
  };

  const empty =
    !identity.name &&
    !identity.email &&
    !identity.phone &&
    !identity.accountId &&
    !identity.accountName &&
    Object.keys(identity.fields).length === 0;

  return empty ? null : identity;
}

/**
 * What makes this identity *this person*, for the purpose of noticing that the
 * browser now belongs to somebody else.
 *
 * The account first: on a shared dashboard machine two colleagues of the same
 * merchant are the same customer for support purposes, and starting a new
 * conversation for each of them would split one account's history in two.
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

function text(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_VALUE);
  return trimmed || null;
}

/**
 * An account number as the platform writes it, with the punctuation a dashboard
 * might have wrapped it in removed. Not `normaliseSbid()` — that is the
 * canonical form for the `shipping_accounts` lookup, and this value is also
 * shown to an agent and compared against what we stored last time.
 */
function identifier(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || null;
}

function extraFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};

  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    // A key that is not an identifier ends up in a jsonb column an agent reads
    // and a rule can match on; keeping it to this shape means neither has to
    // quote it.
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    const flat = text(raw);
    if (flat) fields[key] = flat;
  }

  return fields;
}
