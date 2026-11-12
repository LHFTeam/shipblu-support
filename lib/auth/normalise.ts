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
 * Whether a string is an email address this app can send to, written once.
 *
 * Every question of that kind asks this, in one of two forms. `isEmailAddress`
 * takes the string as it is: `send_notification_email` parses its `to` with it,
 * and `EMAIL_FROM_ADDRESS` is read with it. `looksLikeEmail` takes what somebody
 * typed and normalises it first, as every form does before it stores or queues
 * an address. A form that checks with the second and hands on what it
 * normalised therefore cannot give the worker an address the worker refuses.
 *
 * The rule is the one our provider publishes. Postmark lists the characters it
 * takes before the `@` — ASCII letters and digits and `. ! # $ % & ' * + - / =
 * ^ _ ` { | } ~`, which is RFC 5322's set less `?` — and refuses a dot at
 * either end of that part or two in a row, citing RFC 5322 (it admits taking
 * the first two over its API and not over SMTP, and this takes neither); its
 * domain is letters, digits and hyphens joined by single dots. To that this
 * adds what DNS can route, since a domain that cannot exist can receive
 * nothing: each label starts and ends with a letter or digit, and the last is
 * two or more letters, or an `xn--` label. And RFC 5321's lengths: 64 before
 * the `@`, 254 in all. Postmark's classes are ASCII, so a letter outside it, on
 * either side, is refused, as are a quoted local part and an IP literal.
 *
 * Two checks used to answer the question, each wrong in its own direction.
 * Registration asked `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, the other forms a regex
 * of the same looseness, and the job asked `z.email()`. On 2026-11-12 a
 * customer registered with a Gmail address carrying two dots in a row; the
 * form stored the account and said a link was on its way, and the job refused
 * the address on its first attempt as an invalid payload
 * (`docs/PROJECT-STATE.md` §6.117). Postmark would have refused it too, and
 * Gmail never issues one. But `z.email()` was stricter than Postmark the other
 * way: it is Gmail's username rules, so it refused `&`, `#`, `/` and the rest
 * of RFC 5322's set, which a business address can carry and Postmark delivers
 * to. That is what the side conversations' recipient check had kept itself
 * loose to avoid. Written from the provider's own rule, the one definition
 * refuses what would fail at the provider and nothing it would deliver, so the
 * portal, the side conversations and the job can all ask it.
 *
 * Nothing stored in production failed it when the checks were made one, but
 * the account above: every agent, invite, location, side-conversation
 * recipient and contact address passed.
 *
 * Kept free of zod on purpose: the widget's iframe reaches this module through
 * `parseVisitorDetails`, and a schema here would put zod in a bundle every
 * merchant dashboard loads. The `email-check` repo rule refuses a `z.email()`
 * or an address-shaped regex anywhere but here.
 */
const LOCAL_CHAR = "[A-Za-z0-9!#$%&'*+/=^_`{|}~-]";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const TOP_LABEL = '(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{0,58}[A-Za-z0-9])';
const EMAIL_ADDRESS = new RegExp(
  `^(?=.{1,254}$)(?=[^@]{1,64}@)${LOCAL_CHAR}+(?:\\.${LOCAL_CHAR}+)*@(?:${LABEL}\\.)+${TOP_LABEL}$`,
);

/** The string as given, untrimmed and in its own case: see above. */
export function isEmailAddress(value: string): boolean {
  return EMAIL_ADDRESS.test(value);
}

/**
 * Whether a typed address, once normalised, is one `isEmailAddress` accepts —
 * the check worth making at a form boundary, because it is the one the send
 * path makes.
 *
 * Inbound addresses are *not* validated with this. Mail that arrives has
 * already been delivered, so rejecting its From header would lose a real
 * customer's ticket over punctuation.
 */
export function looksLikeEmail(email: string): boolean {
  return isEmailAddress(normaliseEmail(email));
}
