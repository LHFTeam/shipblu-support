import { createVerify } from 'node:crypto';

/**
 * SNS message verification.
 *
 * SES delivers inbound mail through SNS, and SNS authenticates with an RSA
 * signature over a canonical string rather than an HMAC header — so this cannot
 * reuse the shared-secret path the other providers use.
 *
 * Two things here are load-bearing:
 *
 *  - the signing certificate URL is checked against Amazon's own domains before
 *    it is fetched. Without that check, anyone could post a message naming
 *    their own certificate and every signature would verify.
 *  - the canonical string is built from a fixed field list in a fixed order.
 *    Signing whatever the payload happens to contain would let an attacker move
 *    data into unsigned fields.
 */

export type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  SubscribeURL?: string;
  Token?: string;
};

/** Fields to sign, per message type, in the order SNS specifies. */
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

/**
 * Only Amazon's own hosts, over HTTPS.
 *
 * `sns.<region>.amazonaws.com` and the China and GovCloud partitions. The
 * trailing-dot forms are rejected: `sns.eu-central-1.amazonaws.com.evil.test`
 * must not pass, so the check is on the full hostname, not a suffix match.
 */
export function isTrustedCertUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (!parsed.pathname.endsWith('.pem')) return false;

  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(parsed.hostname);
}

function canonicalString(message: SnsMessage): string {
  const fields = SIGNED_FIELDS[message.Type];
  if (!fields) throw new Error(`Unknown SNS message type "${message.Type}"`);

  const parts: string[] = [];
  for (const field of fields) {
    const value = (message as unknown as Record<string, unknown>)[field];
    // Optional fields (Subject) are omitted entirely when absent, not sent
    // empty — including them would produce a string that never verifies.
    if (value === undefined || value === null) continue;
    parts.push(field, String(value));
  }

  return `${parts.join('\n')}\n`;
}

const certCache = new Map<string, string>();

async function fetchCertificate(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch SNS certificate (${response.status})`);

  const pem = await response.text();
  // SNS rotates certificates rarely, and every inbound email would otherwise
  // cost an extra round trip.
  certCache.set(url, pem);
  return pem;
}

export async function verifySnsMessage(message: SnsMessage): Promise<boolean> {
  const certUrl = message.SigningCertURL ?? message.SigningCertUrl;
  if (!certUrl || !isTrustedCertUrl(certUrl)) return false;
  if (!message.Signature) return false;

  // SignatureVersion 1 is SHA1, 2 is SHA256. Amazon still emits 1 on some
  // topics, so both are accepted; anything else is not a version we know.
  const algorithm =
    message.SignatureVersion === '2'
      ? 'RSA-SHA256'
      : message.SignatureVersion === '1'
        ? 'RSA-SHA1'
        : null;

  if (!algorithm) return false;

  let payload: string;
  try {
    payload = canonicalString(message);
  } catch {
    return false;
  }

  try {
    const certificate = await fetchCertificate(certUrl);
    const verifier = createVerify(algorithm);
    verifier.update(payload, 'utf8');
    verifier.end();
    return verifier.verify(certificate, message.Signature, 'base64');
  } catch (error) {
    console.error('[sns] verification failed', error);
    return false;
  }
}

/**
 * Completes a topic subscription by visiting the URL SNS supplied.
 *
 * Only ever called after the message has verified, so this cannot be used to
 * make the service fetch an arbitrary URL.
 */
export async function confirmSubscription(message: SnsMessage): Promise<boolean> {
  const url = message.SubscribeURL;
  if (!url) return false;

  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/\.amazonaws\.com(\.cn)?$/.test(parsed.hostname)) {
    console.error(`[sns] refusing to confirm subscription against ${parsed.hostname}`);
    return false;
  }

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`[sns] subscription confirmation failed (${response.status})`);
    return false;
  }

  console.log(`[sns] confirmed subscription to ${message.TopicArn}`);
  return true;
}

/** Test seam, and a way to force a refetch if a certificate is ever rotated. */
export function clearCertificateCache(): void {
  certCache.clear();
}
