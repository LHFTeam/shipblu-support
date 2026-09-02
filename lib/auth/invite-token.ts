import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const FORMAT = 'v1';
const PURPOSE = 'shipblu-support/invite-token/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(PURPOSE).update('\0').update(secret).digest();
}

/**
 * Keeps an invite token recoverable for the pending-invites screen without
 * making a database dump sufficient to accept the invite. The hash remains the
 * lookup credential; this ciphertext exists only so an authenticated admin can
 * copy the original link again.
 */
export function sealInviteToken(token: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(PURPOSE));

  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    iv.toString('base64url'),
    encrypted.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/**
 * Returns null for legacy rows, corruption or a token sealed with another
 * APP_SECRET. A secret rotation must not make the whole agents page fail, and
 * the token hash still leaves the original invite usable in that case.
 */
export function unsealInviteToken(value: string, secret: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT) return null;

  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const encrypted = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || encrypted.length === 0 || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
    decipher.setAAD(Buffer.from(PURPOSE));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
