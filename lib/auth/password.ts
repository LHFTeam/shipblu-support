import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with OWASP's recommended second option (19 MiB, t=2, p=1).
 *
 * Memory cost matters more than time cost against GPU attacks, and 19 MiB per
 * hash is affordable here: sign-in is rare and the web service has 2 GB.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password, OPTIONS);
  } catch {
    // Malformed or truncated hash in the database — treat as a failed login
    // rather than a 500, so one bad row cannot lock out the console.
    return false;
  }
}

/**
 * Minimum viable policy: length over composition rules, which is what current
 * NIST guidance recommends. Agents are staff, so we do not also need throttled
 * self-service signup.
 */
export function validatePasswordStrength(
  password: string,
): { ok: true } | { ok: false; reason: string } {
  if (password.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters' };
  }
  if (password.length > 200) {
    return { ok: false, reason: 'Password must be at most 200 characters' };
  }
  return { ok: true };
}
