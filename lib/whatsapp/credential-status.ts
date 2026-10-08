/**
 * What the console may know about a stored WhatsApp credential — everything
 * except the credential.
 *
 * Pure and client-safe, split from `credentials.ts` the way `lib/forms/files.ts`
 * is split from `attachments.ts`: the admin page renders these badges, and the
 * module that reads the table imports the database and `node:crypto`, neither of
 * which may reach a browser bundle.
 *
 * `CredentialStatus` is a named field list with no secret in it, and CI keeps it
 * that way (`credential-confinement`): the page that shows it renders every
 * field it is handed into an RSC payload, so a field added here is a field
 * published to whoever can open the admin screen.
 */

/**
 * Whether the key a credential was sealed under is one this process holds.
 *
 * Answered from the key id alone, without decrypting, so a page can say "this
 * credential is unreadable" without the web service ever opening one.
 */
export type KeyState = 'current' | 'previous' | 'unknown' | 'no_key';

export type CredentialStatus = {
  accountId: string;
  /** Which key sealed it — the first 8 hex of a hash of the key, not the key. */
  keyId: string;
  keyState: KeyState;
  /**
   * Why the configured key could not be read at all, when it could not — the
   * sentence names the variable, never its value. Null when the keyring parsed.
   */
  keyProblem: string | null;
  /** Where the credential came from. Only `embedded_signup` writes one today. */
  source: string;
  /** Meta's `type` from `debug_token` — SYSTEM_USER, USER, … */
  tokenType: string | null;
  scopes: string[] | null;
  businessId: string | null;
  issuedAt: Date | null;
  /**
   * Null means the token never expires — *if* it was inspected. A credential
   * that has never been inspected also has a null here, which is why
   * `inspectedAt` exists: "never expires" and "nobody asked" are different
   * claims and a badge must not print the first when it only knows the second.
   */
  expiresAt: Date | null;
  dataAccessExpiresAt: Date | null;
  inspectedAt: Date | null;
  obtainedByAgentId: string | null;
  lastVerifiedAt: Date | null;
  lastRefusedAt: Date | null;
  /** Meta's sentence for the refusal, as the template sync recorded it. */
  lastRefusal: string | null;
  /** When this token was stored — a reconnect moves it. */
  storedAt: Date;
};

/**
 * How long before expiry the console starts saying so.
 *
 * A week, because the fix is a person signing in through Meta's window, and a
 * credential that expires over a weekend is otherwise found by the first
 * customer reply that fails on Monday.
 */
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

export type CredentialBadge = {
  tone: 'neutral' | 'warning' | 'danger';
  label: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The badges a credential earns, most urgent first.
 *
 * A refusal outranks a clock. `expiresAt` is what Meta said when it was asked,
 * and a business can revoke the app the next minute; `lastRefusedAt` is Meta
 * saying no today. So a credential refused since its last success reads as
 * refused even if its expiry is a year away.
 */
export function credentialBadges(status: CredentialStatus, now: Date): CredentialBadge[] {
  const badges: CredentialBadge[] = [];

  if (status.keyState === 'no_key') {
    badges.push({
      tone: 'danger',
      label: status.keyProblem
        ? 'credential key misconfigured'
        : 'credential key not set — WHATSAPP_CREDENTIAL_KEY',
    });
  } else if (status.keyState === 'unknown') {
    badges.push({
      tone: 'danger',
      label: `sealed under key ${status.keyId}, which this deployment does not hold`,
    });
  } else if (status.keyState === 'previous') {
    badges.push({ tone: 'warning', label: `sealed under the previous key — rotation pending` });
  }

  const refusedSinceVerified =
    status.lastRefusedAt !== null &&
    (status.lastVerifiedAt === null || status.lastRefusedAt > status.lastVerifiedAt);

  if (refusedSinceVerified) {
    badges.push({ tone: 'danger', label: 'credential refused by Meta' });
  }

  if (status.inspectedAt === null) {
    badges.push({ tone: 'neutral', label: 'expiry unknown' });
  } else if (status.expiresAt === null) {
    badges.push({ tone: 'neutral', label: 'never expires' });
  } else {
    const left = status.expiresAt.getTime() - now.getTime();
    if (left <= 0) {
      badges.push({ tone: 'danger', label: 'credential expired' });
    } else if (left <= EXPIRY_WARNING_MS) {
      const days = Math.ceil(left / DAY_MS);
      badges.push({
        tone: 'warning',
        label: `credential expires in ${days} day${days === 1 ? '' : 's'}`,
      });
    }
  }

  return badges;
}
