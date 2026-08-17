import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session, invite, password-reset and CSAT tokens all follow the same rule:
 * the raw token is handed out exactly once (cookie, email link) and only its
 * SHA-256 is stored. A database leak therefore yields no usable credential.
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
