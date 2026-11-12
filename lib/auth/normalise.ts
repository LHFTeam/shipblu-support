import { stripInvisible } from '@/lib/shipments/format';

/**
 * Email addresses arrive from three directions — agent sign-in, inbound mail
 * headers, and imports — and must normalise identically in all three, because
 * `contact_identities` enforces uniqueness on the normalised value.
 *
 * Two steps beyond trimming and lowercasing, each because the address someone
 * pastes is not the address they mean. Bidi and zero-width marks go first
 * (`stripInvisible`, the one list search and the subcategoriser use): an
 * address copied out of an RTL WhatsApp chat carries a U+200F, which `trim()`
 * keeps because it is a format character rather than whitespace, and the
 * address would otherwise be refused, or stored as a second identity, for a
 * character nobody can see. And a domain written in another script —
 * `مثال.مصر`, `münchen.de` — becomes its ASCII form (`xn--…`), the one
 * Postmark's ASCII domain class takes and the one mail from that domain
 * carries, so the stored address is the one a reply can go to and the one an
 * inbound message from it resolves onto.
 */
export function normaliseEmail(email: string): string {
  return asciiDomain(stripInvisible(email).trim().toLowerCase());
}

/**
 * The domain's ASCII form, through the URL parser's own IDNA, which the
 * browser has as well as Node — the widget's iframe normalises addresses too.
 * Only a domain outside ASCII that is nothing but a host name is handed to it:
 * the parser would read `/`, `?`, `#`, `@` or `:` as the end of the host and
 * keep what came before, so `amira@مثال.مصر/x` would lose its `/x` and pass.
 * Anything it cannot read is left as written, for `isEmailAddress` to refuse.
 */
function asciiDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return address;
  const domain = address.slice(at + 1);
  if (/^[\x00-\x7F]*$/.test(domain) || !/^[^\s/?#@:\\%[\]]+$/.test(domain)) return address;
  try {
    return `${address.slice(0, at)}@${new URL(`http://${domain}`).hostname}`;
  } catch {
    return address;
  }
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
 * and every sender checks `EMAIL_FROM_ADDRESS` with it where it sends
 * (`senderAddress`), never in `env()`, where a format rule takes every service
 * down over one variable. `looksLikeEmail` takes what somebody typed and
 * normalises it first, as every form does before it stores or queues an
 * address. A form that checks with the second and hands on what it normalised
 * therefore cannot give the worker an address the worker refuses.
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
 * the `@`, 254 in all. Postmark's classes are ASCII, so a letter outside it
 * before the `@` is refused — nothing here sends SMTPUTF8 — as are a quoted
 * local part and an IP literal; one after it has been made ASCII already by
 * `normaliseEmail`. Case is never the question, the `xn--` prefix included:
 * DNS ignores it, and `isEmailAddress` is asked of strings nobody lowercased.
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
  'i',
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
