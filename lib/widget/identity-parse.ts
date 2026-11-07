import { looksLikeEmail, normaliseEmail, normalisePhone } from '@/lib/auth/normalise';

/**
 * Reading what a host page says about its visitor, apart from deciding what it
 * proves.
 *
 * Split from `identity.ts` by which side of the wire runs it, as
 * `lib/kb/floors.ts` is split from `internal.ts`: that module signs with
 * `node:crypto` and reads `env()`, and the widget's frame has to parse an
 * identity the same way the server does before it decides whether to resume a
 * stored conversation (`lib/widget/person.ts`). Two parsers would disagree
 * about whose email `Nour@Merchant.example ` is, and the frame's check would
 * then refuse or admit somebody the server reads as somebody else. Read
 * `identity.ts`'s header for what a parsed identity is allowed to do.
 */

export type WidgetIdentity = {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** The merchant's account number on the shipping platform, if the host knows it. */
  accountId: string | null;
  accountName: string | null;
  /** Anything else the host chose to send, flattened to strings. */
  fields: Record<string, string>;
};

/** Long enough for a real value, short enough that nobody stores a document here. */
const MAX_VALUE = 200;
const MAX_FIELDS = 20;

export function parseIdentity(raw: unknown): WidgetIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  /*
   * `name`, or first and last joined. Both shapes because a dashboard holds the
   * two halves separately far more often than it holds the whole — the
   * Freshchat config this replaces sent `firstName` and `lastName`.
   */
  const joined = [text(input.firstName), text(input.lastName)]
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, MAX_VALUE);
  const name = text(input.name) ?? (joined || null);

  const rawEmail = text(input.email);
  const email = rawEmail && looksLikeEmail(rawEmail) ? normaliseEmail(rawEmail) : null;

  // Digits only, and only if there are enough of them to be a number rather
  // than an extension somebody pasted.
  const digits = normalisePhone(text(input.phone) ?? '');
  const phone = digits.length >= 6 && digits.length <= 20 ? digits : null;

  const accountId = identifier(input.accountId ?? input.account_id);
  const accountName = text(input.accountName ?? input.account_name);

  const identity: WidgetIdentity = {
    name,
    email,
    phone,
    accountId,
    accountName,
    fields: extraFields(input.meta ?? input.fields),
  };

  const empty =
    !identity.name &&
    !identity.email &&
    !identity.phone &&
    !identity.accountId &&
    !identity.accountName &&
    Object.keys(identity.fields).length === 0;

  return empty ? null : identity;
}

function text(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_VALUE);
  return trimmed || null;
}

/**
 * An account number as the platform writes it, with the punctuation a dashboard
 * might have wrapped it in removed. Not `normaliseSbid()` — that is the
 * canonical form for the `shipping_accounts` lookup, and this value is also
 * shown to an agent and compared against what we stored last time.
 */
function identifier(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || null;
}

function extraFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};

  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    // A key that is not an identifier ends up in a jsonb column an agent reads
    // and a rule can match on; keeping it to this shape means neither has to
    // quote it.
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    const flat = text(raw);
    if (flat) fields[key] = flat;
  }

  return fields;
}
