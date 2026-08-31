import { normaliseEmail, normalisePhone } from '@/lib/auth/normalise';

/**
 * The details a visitor leaves when nobody is available to chat.
 *
 * Parsed here rather than in the route so the rule — *one* way back is enough —
 * is stated once and can be tested without a request. Out of hours the widget
 * asks for a name, an email and a phone number; the team needs a way to reach
 * the person, not a complete record, and insisting on both loses the visitor who
 * only has one of them to hand.
 */

export type VisitorDetails = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

/** Deliberately loose, like the address check beside it: a valid-but-unusual
 *  address that we reject is a customer we lose, and one that we accept and
 *  cannot deliver to surfaces as a bounce, which is the right place for it. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Digits only, and only a plausible count of them.
 *
 * `normalisePhone` has already stripped '+', spaces and dashes, so this is
 * counting digits rather than validating a format. Eight is shorter than any
 * national number worth calling; fifteen is E.164's own ceiling. No Egypt-shaped
 * rule beyond that on purpose — the widget is embedded on sites whose customers
 * are not all in Egypt, and a stricter pattern would reject them silently.
 */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function parseVisitorDetails(body: {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
}): VisitorDetails | null {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) || null : null;

  const suppliedEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';
  const email = EMAIL.test(suppliedEmail) ? normaliseEmail(suppliedEmail) : null;

  const suppliedPhone =
    typeof body.phone === 'string' ? normalisePhone(body.phone.slice(0, 40)) : '';
  const phone =
    suppliedPhone.length >= MIN_DIGITS && suppliedPhone.length <= MAX_DIGITS ? suppliedPhone : null;

  // A name alone is not a way back, so it does not count. Rejecting here rather
  // than storing the name and nothing else keeps "we have their details" and "we
  // can answer them" the same fact.
  if (!email && !phone) return null;

  return { name, email, phone };
}
