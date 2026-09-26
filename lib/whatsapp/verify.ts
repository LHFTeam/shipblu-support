import { createHmac, timingSafeEqual } from 'node:crypto';
import { safeEqual } from '@/lib/auth/tokens';

/**
 * X-Hub-Signature-256 verification for Meta webhooks.
 *
 * The signature is HMAC-SHA256 of the *raw* request body with the app secret —
 * raw meaning the exact bytes Meta sent. Re-serialising the parsed JSON
 * produces a different string (key order, whitespace, unicode escaping) and the
 * check then fails for reasons that look like a wrong secret, so the route must
 * read the body as text and pass it here untouched.
 */

export const SIGNATURE_HEADER = 'x-hub-signature-256';

export function verifySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const [algorithm, provided] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !provided) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');

  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // mismatched length is not a secret worth protecting anyway.
  if (provided.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Meta's subscription handshake: it GETs the endpoint with a challenge and only
 * enables the webhook if we echo it back. Returns the challenge to send, or null
 * to reject.
 */
export function verifyChallenge(params: URLSearchParams, verifyToken: string): string | null {
  if (params.get('hub.mode') !== 'subscribe') return null;
  if (!verifyToken) return null;

  const provided = params.get('hub.verify_token');
  if (!provided) return null;

  if (!safeEqual(provided, verifyToken)) return null;

  return params.get('hub.challenge');
}
