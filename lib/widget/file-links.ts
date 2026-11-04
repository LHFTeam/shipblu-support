import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * The address a widget draws a file from: one file, for a few hours, and
 * nothing else.
 *
 * A picture, a player and a link carry their address in the open — "Copy image
 * address", a tab opened from the link, a history entry — so what is in the
 * address is what a visitor hands over when they share it. The visitor's token
 * is their whole chat, read and written, and nothing on the server ever
 * expires it; an address carrying it turned every photo shown to a colleague
 * into the conversation, still open after the host page signed its user out
 * (`clear()`). So the transcript (`listMessages`) signs a link per file
 * instead, and `/api/widget/attachments/[id]` asks only whether the signature
 * is ours and current. A shared link opens that one file until it expires.
 *
 * An HMAC under `APP_SECRET`, with a purpose of its own in the signed text, as
 * the health probe's is (`lib/health/probe.ts`), so no other signature the
 * secret makes can stand in for one of these. The expiry is part of what is
 * signed.
 *
 * **The expiry moves in steps**, not with each call. The transcript is re-read
 * on every push to an open widget, and an address that changed every time
 * would make every picture in the thread fetch itself again on every agent
 * reply. So every link minted within one window ends at the same instant, the
 * end of the window after it: valid for six to twelve hours, and the same
 * string across every push in between.
 */

const WINDOW_SECONDS = 6 * 60 * 60;
const PURPOSE = 'widget-file';

/** When a link minted at `now` stops working, in seconds since the epoch. */
export function fileLinkExpiry(now: Date): number {
  const seconds = Math.floor(now.getTime() / 1000);
  return (Math.floor(seconds / WINDOW_SECONDS) + 2) * WINDOW_SECONDS;
}

function signature(attachmentId: string, expires: number): string {
  return createHmac('sha256', env().APP_SECRET)
    .update(`${PURPOSE}:${attachmentId}:${expires}`)
    .digest('base64url');
}

/** The relative address the widget draws a stored file from. */
export function widgetFileUrl(attachmentId: string, now: Date): string {
  const expires = fileLinkExpiry(now);
  const query = new URLSearchParams({
    expires: String(expires),
    signature: signature(attachmentId, expires),
  });
  return `/api/widget/attachments/${encodeURIComponent(attachmentId)}?${query.toString()}`;
}

/**
 * Whether a link is one this server signed for this file and has not expired.
 *
 * An expiry later than any this server would mint at `now` is refused as well,
 * though only the secret can sign one: it costs nothing, and a link that
 * claims to live for a year is not one of ours whatever its signature says.
 */
export function fileLinkValid(
  attachmentId: string,
  expires: string | null,
  given: string | null,
  now: Date,
): boolean {
  if (!expires || !given || !/^\d{1,12}$/.test(expires)) return false;
  const at = Number(expires);
  if (at * 1000 <= now.getTime() || at > fileLinkExpiry(now)) return false;

  const expected = Buffer.from(signature(attachmentId, at));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
