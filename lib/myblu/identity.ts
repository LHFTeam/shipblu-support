import { createHmac } from 'node:crypto';
import { looksLikeEmail, normaliseEmail, normalisePhone } from '@/lib/auth/normalise';
import { safeEqual } from '@/lib/auth/tokens';
import { env } from '@/lib/env';
import { subjectFor, type PlatformProfile } from './platform';

/**
 * What the myBlu app says about its user, and what may be believed.
 *
 * Read `lib/widget/identity.ts` first — this is the same boundary drawn for a
 * different caller, and the rule it states is the one thing here that must not
 * bend: **an unverified claim may decorate the contact it already resolved to,
 * and may never adopt a different one.**
 *
 * The app's position is stronger than a browser's and weaker than it looks. It
 * carries a real credential, so the handshake knows a *live myBlu user* is
 * calling. But the phone it sends is a separate assertion with nothing linking
 * it to that credential: the bearer proves "somebody", the phone claims "this
 * one". Believing the pair would let any myBlu user read any Egyptian mobile's
 * support history, which is precisely the widget's attack arriving through a
 * door marked "verified, there was a token".
 *
 * So the phone is only ever a fact when **`api.shipblu.com` said it** — through
 * introspection, or through a signature the platform's backend minted. What the
 * app itself sends is decoration: a name to show an agent, and a number that
 * makes the person findable as a merge candidate.
 */

/** Long enough for a real value, short enough that nobody stores a document. */
const MAX_VALUE = 200;

/** An install id is ours to shape: a UUID is 36 characters, so this is generous. */
const MAX_INSTALL_ID = 128;
const MIN_INSTALL_ID = 16;

export type MobileClaim = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

export function parseClaim(raw: unknown): MobileClaim {
  if (!raw || typeof raw !== 'object') return { name: null, email: null, phone: null };
  const input = raw as Record<string, unknown>;

  const joined = [text(input.firstName), text(input.lastName)].filter(Boolean).join(' ').trim();
  const name = text(input.name) ?? (joined || null);

  const rawEmail = text(input.email);
  const email = rawEmail && looksLikeEmail(rawEmail) ? normaliseEmail(rawEmail) : null;

  const digits = normalisePhone(text(input.phone) ?? '');
  const phone = digits.length >= 6 && digits.length <= 20 ? digits : null;

  return { name, email, phone };
}

/**
 * The install id, or null if the app did not send a usable one.
 *
 * A minimum length, because this is what a device-scoped session is filed
 * under: a short or empty value would put every app that sent one onto the same
 * contact. Shape rather than format, so the app may use a UUID today and
 * something else later without a deploy here.
 */
export function parseInstallId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < MIN_INSTALL_ID || value.length > MAX_INSTALL_ID) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
}

/**
 * The string the platform's backend would sign, if it signs at all.
 *
 * Deliberately the same shape as the widget's `signedClaim` — the identifying
 * half only, phone before email. Name is decoration and covering it would mean
 * a customer editing their profile silently stops being identified.
 *
 * Documented in `docs/myblu-support-api.md`, so changing it breaks a deployed
 * integration: add a second accepted form rather than editing this one.
 */
export function signedClaim(claim: MobileClaim): string {
  return `${claim.phone ?? ''}|${claim.email ?? ''}`;
}

/** Whether a secret is configured at all. Unset means signatures are ignored. */
export function identitySigningEnabled(): boolean {
  return Boolean(env().MOBILE_IDENTITY_SECRET);
}

/**
 * Whether the platform, rather than the app, is asserting this claim.
 *
 * False when no secret is configured: an integration that has not been given
 * one cannot be producing real signatures, and treating an unverifiable one as
 * valid would make the whole mechanism decorative.
 */
export function verifyClaim(claim: MobileClaim, signature: unknown): boolean {
  const secret = env().MOBILE_IDENTITY_SECRET;
  const supplied = typeof signature === 'string' ? signature.trim().toLowerCase() : '';
  if (!secret || !supplied) return false;

  const expected = createHmac('sha256', secret).update(signedClaim(claim)).digest('hex');
  return safeEqual(expected, supplied);
}

/**
 * Who this handshake is for, once every source has had its say.
 *
 * `verified` is the whole output: it decides whether the phone may reach an
 * existing contact or may only decorate a new one, and it is recorded on the
 * session so the console can badge a ticket with how much the name should be
 * trusted.
 */
export type ResolvedIdentity = {
  /** Platform-asserted where `verified`, the app's claim where not. */
  phone: string | null;
  email: string | null;
  name: string | null;
  /** The comparable key, or null when nothing identifying was asserted. */
  subject: string | null;
  verified: boolean;
};

/**
 * Merge what the platform said with what the app claimed.
 *
 * Three sources, and the order between them is the design:
 *
 *  1. **Introspection.** Already a backend assertion — this system asked
 *     `api.shipblu.com` directly and it answered for that token. Anything here
 *     is a fact and wins outright.
 *  2. **A verified signature.** The platform's backend saying the same thing by
 *     a different route, for the day it would rather sign at login than widen
 *     what the profile endpoint returns. Also a fact.
 *  3. **The app's claim.** Decoration. It fills gaps in the *display* fields and
 *     never contributes a subject, so it can never select a contact.
 *
 * The asymmetry in the last line is the point. A claimed phone still travels —
 * it is written to `contacts.primary_phone` by the caller, which is what makes
 * the person surface as a merge candidate an agent can confirm — but it is not
 * a subject, so nothing resolves onto an existing contact because of it.
 */
export function resolveIdentity(input: {
  profile: PlatformProfile;
  subject: string | null;
  claim: MobileClaim;
  signatureVerified: boolean;
}): ResolvedIdentity {
  const { profile, claim } = input;

  if (input.subject) {
    return {
      phone: profile.phone,
      email: profile.email,
      // The platform's name first, then the app's: both are the same person's
      // profile, and the app may hold one the platform has not been told.
      name: profile.name ?? claim.name,
      subject: input.subject,
      verified: true,
    };
  }

  if (input.signatureVerified) {
    const subject = subjectFor(claim.phone, claim.email);
    if (subject) {
      return {
        phone: claim.phone,
        email: claim.email,
        name: claim.name ?? profile.name,
        subject,
        verified: true,
      };
    }
  }

  // Nothing identifying was asserted by anyone who may assert it. The claim
  // still travels as decoration, and `subject: null` is what routes this
  // session down the device-scoped path.
  return {
    phone: claim.phone ?? profile.phone,
    email: claim.email ?? profile.email,
    name: claim.name ?? profile.name,
    subject: null,
    verified: false,
  };
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_VALUE);
  return trimmed || null;
}
