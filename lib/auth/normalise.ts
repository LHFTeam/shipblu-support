/**
 * Email addresses arrive from three directions — agent sign-in, inbound mail
 * headers, and imports — and must normalise identically in all three, because
 * `contact_identities` enforces uniqueness on the normalised value.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * WhatsApp identifiers are E.164 without the leading '+'. Meta sends them that
 * way in webhooks (e.g. 201001234567), but agents and imported data often carry
 * '+', spaces or dashes.
 */
export function normalisePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

export function normaliseIdentifier(channel: string, identifier: string): string {
  switch (channel) {
    case 'email':
      return normaliseEmail(identifier);
    case 'whatsapp':
      return normalisePhone(identifier);
    default:
      // Facebook PSIDs and Instagram IGSIDs are opaque and case-sensitive.
      return identifier.trim();
  }
}

/**
 * A conservative "is this an address at all?" check.
 *
 * Not RFC 5322 — that grammar accepts things no mail provider will, and a
 * validator strict enough to be interesting rejects addresses that genuinely
 * work. This is the check worth making at a form boundary: one `@`, something
 * either side of it, a dot in the domain, and no whitespace. Anything that
 * passes and still bounces is a delivery problem, which is the right place for
 * it to surface.
 *
 * Inbound addresses are *not* validated with this. Mail that arrives has
 * already been delivered, so rejecting its From header would lose a real
 * customer's ticket over punctuation.
 */
export function looksLikeEmail(email: string): boolean {
  const value = normaliseEmail(email);
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}
