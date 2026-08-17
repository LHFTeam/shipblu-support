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
