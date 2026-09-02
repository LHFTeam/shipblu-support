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

/** Constant-time compare for any secret we check by value rather than by index. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
