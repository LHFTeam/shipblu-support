/**
 * The postMessage protocol between the widget's frame (`app/widget/chat.tsx`)
 * and the snippet on the host page (`app/widget/embed.js/route.ts`).
 *
 * Declared once because the two sides are checked by different things and a
 * mismatch is an error in neither: a name the frame sends that the snippet does
 * not listen for is simply dropped, and what stops working is a badge that
 * never shows an unread reply or a sign-out that never clears the session. The
 * frame reads these as typed constants. The snippet is JavaScript inside a
 * template literal, so it is handed them as data at the top of the script, and
 * its route test checks every name the served script uses is one of these.
 *
 * The values are the wire format, not labels. A host page can hold a cached
 * copy of the snippet from before a change while the frame it opens is today's,
 * so a name here is never renamed — a new one is added beside it.
 */

/** Which side sent a message; each side ignores anything not from the other. */
export const SOURCE = { widget: 'shipblu-widget', host: 'shipblu-host' } as const;

/** What the frame tells the host page. */
export const WIDGET_SAYS = {
  ready: 'ready',
  hello: 'hello',
  unread: 'unread',
  close: 'close',
} as const;

/** What the host page tells the frame. */
export const HOST_SAYS = {
  opened: 'opened',
  closed: 'closed',
  identify: 'identify',
  compose: 'compose',
  clear: 'clear',
} as const;
