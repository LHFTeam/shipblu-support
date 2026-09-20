import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { normaliseEmail, normalisePhone, looksLikeEmail } from '@/lib/auth/normalise';
import { DEFAULT_SHIPBLU_API_URL, ShipbluApiError } from '@/lib/shipments/platform';

/**
 * Asking the delivery platform who a myBlu access token belongs to.
 *
 * myBlu signs its users in with a phone OTP against `api.shipblu.com` and keeps
 * the **opaque, long-lived bearer** it gets back. There are no claims in it, no
 * signature to check and no user id anywhere in the app — so this system cannot
 * tell who is calling without asking the party that issued the credential.
 *
 * ## Why this runs on the request path
 *
 * AGENTS.md says anything slow, external or retryable is a job, with one
 * documented exception for a control an agent presses and waits on. This is a
 * **second** exception and is written down as one rather than filed under the
 * first, because the first's reasoning does not quite fit: that rule exists so a
 * customer's ticket never depends on a provider being up, and a handshake that
 * fails means they cannot open support at all.
 *
 * The argument that does fit is structural: **an authentication decision cannot
 * be queued.** A job answering "is this token live" thirty seconds later is
 * useless to a caller holding a request open, and a credential check has no
 * retry semantics — neither of the rule's two purposes applies. So it runs here,
 * exactly once per handshake, and the support session token carries the answer
 * afterwards. Nothing re-introspects per request, which is what keeps this call
 * off the message-polling path the app spends its time on.
 *
 * ## What comes back, and the one thing not known here
 *
 * `/api/v1/myshipblu/customer-accounts/` is the endpoint myBlu itself calls to
 * fill in a profile after login. Its own zod DTO lists `email`, `first_name` and
 * `last_name` — and a non-strict zod object *strips* what it does not name, so
 * the platform may well return more than the app has ever seen. **Whether it
 * returns the phone decides how much of the identity below is a fact**, so this
 * parser reads every field name the platform might plausibly use for one and
 * treats their absence as the ordinary case rather than as an error.
 *
 * A 200 is the whole authentication result. The profile is a bonus: a token can
 * be perfectly live and name a customer whose email was never filled in.
 */

/** Long enough for a slow round trip, short enough that a person keeps waiting. */
export const INTROSPECT_TIMEOUT_MS = 3_500;

/** How long an answer is reused for. */
const CACHE_TTL_MS = 60_000;

/**
 * Deliberately smaller than the widget's rate-limit bucket cap. A live cache
 * entry is a credential's worth of identity held in memory; this is the number
 * of *concurrent* apps re-handshaking within a minute, not a session count.
 */
const MAX_CACHE = 5_000;

export type PlatformProfile = {
  /** Digits only, or null when the platform did not name one. */
  phone: string | null;
  email: string | null;
  name: string | null;
};

/**
 * The person a live token belongs to, as the platform describes them.
 *
 * `subject` is the stable key this system files them under, and null is a real
 * answer: it means the token is live but the platform named nothing to file it
 * against, which is what puts the session on the device-scoped path.
 */
export type Introspection = {
  profile: PlatformProfile;
  subject: string | null;
};

/**
 * Every spelling of a phone number the platform might use.
 *
 * Listed rather than guessed at one name, because reading the wrong key is
 * indistinguishable from the platform not sending one — both produce an
 * unverified session, silently, for every user. The cost of an extra name here
 * is nothing; the cost of missing the right one is that the feature's whole
 * identity model quietly degrades.
 */
const profileSchema = z
  .object({
    email: z.string().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    name: z.string().nullish(),
    phone: z.string().nullish(),
    phone_number: z.string().nullish(),
    mobile: z.string().nullish(),
    customer_phone: z.string().nullish(),
  })
  .loose();

type CacheEntry = { at: number; value: Introspection };
const cache = new Map<string, CacheEntry>();

/**
 * Who this token belongs to, or a throw.
 *
 * Throws `ShipbluApiError` with `status: 401` when the platform rejects the
 * token — the one case where the caller should tell the app to sign out — and
 * with `isTransient` when the platform could not be reached, which must never
 * become a session. A fallback to an unverified session on an outage would turn
 * a platform being down into a way to open one with no credential at all.
 */
export async function introspect(bearer: string, baseUrl?: string): Promise<Introspection> {
  const key = createHash('sha256').update(bearer).digest('hex');

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const base = (baseUrl ?? env().SHIPBLU_API_URL ?? DEFAULT_SHIPBLU_API_URL).replace(/\/+$/, '');
  const value = await fetchProfile(`${base}/api/v1/myshipblu/customer-accounts/`, bearer);

  if (cache.size >= MAX_CACHE) prune();
  cache.set(key, { at: Date.now(), value });

  return value;
}

/** Exported for the tests; nothing else should need it. */
export function clearIntrospectionCache(): void {
  cache.clear();
}

async function fetchProfile(url: string, bearer: string): Promise<Introspection> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ShipbluApiError(
      `Could not reach the delivery platform: ${error instanceof Error ? error.message : error}`,
      null,
      true,
    );
  }

  // 401 and 403 are the platform saying the credential is no good. 404 is too:
  // the endpoint exists, so a miss means it resolved the token to no account.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new ShipbluApiError('The delivery platform rejected this token', 401, false);
  }

  if (!response.ok) {
    const isTransient = response.status === 429 || response.status >= 500;
    throw new ShipbluApiError(
      `Delivery platform returned ${response.status} for a token introspection`,
      response.status,
      isTransient,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A 200 carrying something that is not JSON is a proxy or a captive portal
    // answering instead of the platform — the same shape `lib/shipments/platform.ts`
    // names, and for the same reason: this API serves HTML for a bad path.
    throw new ShipbluApiError(
      'Delivery platform returned a 200 that was not JSON for a token introspection',
      response.status,
      true,
    );
  }

  return readProfile(body);
}

/**
 * The profile and its subject, from whatever the platform sent.
 *
 * Pure and exported so a test can assert the one thing that matters most and
 * cannot be observed without a real token: that a response carrying a phone is
 * recognised whichever of its plausible names it arrives under, and that one
 * carrying none produces `subject: null` rather than a guess.
 */
export function readProfile(body: unknown): Introspection {
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) return { profile: { phone: null, email: null, name: null }, subject: null };

  const row = parsed.data;

  const rawPhone = row.phone ?? row.phone_number ?? row.mobile ?? row.customer_phone ?? '';
  const digits = normalisePhone(rawPhone);
  // The same floor `parseIdentity` puts on a widget claim: enough digits to be a
  // number rather than an extension somebody pasted into the wrong box.
  const phone = digits.length >= 6 && digits.length <= 20 ? digits : null;

  const rawEmail = (row.email ?? '').trim();
  const email = rawEmail && looksLikeEmail(rawEmail) ? normaliseEmail(rawEmail) : null;

  const joined = [row.first_name, row.last_name]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const name = (row.name ?? '').trim() || joined || null;

  return { profile: { phone, email, name }, subject: subjectFor(phone, email) };
}

/**
 * What the platform named this person, as one comparable string.
 *
 * The phone first, because it is myBlu's login credential and the only field
 * every user has: an email is optional there and frequently empty. Prefixed by
 * kind so a number and an address can never collide, and so a later reader can
 * tell which of the two the platform actually asserted.
 */
export function subjectFor(phone: string | null, email: string | null): string | null {
  if (phone) return `phone:${phone}`;
  if (email) return `email:${email}`;
  return null;
}

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  if (cache.size >= MAX_CACHE) cache.clear();
}
