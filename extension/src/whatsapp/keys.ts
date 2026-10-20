/**
 * Reading WhatsApp Web's own identifiers, pure so they can be tested.
 *
 * A message on WhatsApp Web is keyed `<fromMe>_<chat jid>_<message id>`, with a
 * fourth part naming the sender in a group: `false_201154311931@c.us_3EB0…`,
 * `true_98801629040701@lid_FC14…`. The server stores the same message under a
 * wamid, and `wamidKey` (`lib/whatsapp/wamid.ts`) decodes that to `fromMe` and
 * the id. This is the other half: the same pair, read off the page.
 *
 * The chat part is dropped for the reason `wamidKey` drops it. It is the half
 * that varies between copies of one message, and on a chat WhatsApp has moved
 * to an `@lid` it carries no phone number at all — which is why the panel finds
 * a ticket by its messages rather than by the customer's number.
 */

const MESSAGE_KEY = /^(true|false)_[^_\s]+@[^_\s]+_([A-Za-z0-9]+)(?:_.*)?$/;

/** `true_…@c.us_3EB0…` → `out:3EB0…`, or null for anything else. */
export function messageKey(raw: string): string | null {
  const match = MESSAGE_KEY.exec(raw.trim());
  if (!match) return null;
  return `${match[1] === 'true' ? 'out' : 'in'}:${match[2]}`;
}

/**
 * The number WhatsApp Web is signed in as, from its own `last-wid-md` entry in
 * `localStorage` — `"201234567890:12@c.us"`, JSON-quoted, the part after the
 * colon being the device. Digits only, or null when the value is missing or
 * not that shape: a guess here would compare the wrong number against the
 * console's and offer the wrong number's tickets.
 */
export function ownNumber(stored: string | null): string | null {
  if (!stored) return null;
  let value = stored;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed === 'string') value = parsed;
  } catch {
    // Not JSON — read as it stands.
  }
  const match = /^(\d{8,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(value.trim());
  return match?.[1] ?? null;
}
