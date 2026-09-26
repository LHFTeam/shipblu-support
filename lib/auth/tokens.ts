import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Every opaque-token lookup uses a SHA-256 rather than the credential itself.
 * Sessions, password resets and CSAT surveys store only that hash. Invites also
 * keep an AES-GCM envelope through `invite-token.ts` so an authenticated admin
 * can copy a pending link again; the raw value is never stored in plaintext and
 * a database leak alone still yields no usable credential.
 *
 * SHA-256 rather than argon2 is deliberate here — these are 256-bit random
 * values, not user-chosen secrets, so there is nothing to brute-force and the
 * lookup needs to be a fast indexed equality check.
 */

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time compare for any secret we check by value rather than by index.
 *
 * The one copy. The widget's identity signature already used it; the Postmark
 * webhook's password, Meta's verify token and the Render probe's header each
 * wrote it out by hand, and each had to remember the same two things: compare
 * bytes rather than characters, because `timingSafeEqual` throws on a length
 * mismatch and `'é'` is one character but two bytes; and check the lengths
 * first, which gives away only how long the secret is. A fourth copy that
 * forgot either one would read as correct.
 *
 * Not for the hex HMAC in `lib/whatsapp/verify.ts`, which compares the decoded
 * digests rather than the strings.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
