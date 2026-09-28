import { SOURCE } from './protocol';

/**
 * Whether a `message` event arriving in the widget's frame is the host page
 * speaking, and so may identify the visitor, wipe their session or fill the
 * composer.
 *
 * Three checks, each closing something the others do not:
 *
 * - **The origin is allowed**: our own, because the help centre frames itself,
 *   or one on the widget's allowlist. This is the documented guard.
 * - **The sender is the parent window.** `parent.frames` is reachable from any
 *   other frame on the host page, so an ad or a second embed served from an
 *   allowed origin could otherwise post as the host. The host page is the one
 *   window that framed us, and only it may speak for the visitor.
 * - **The message carries the host's tag**, which tells ours apart from any
 *   other postMessage traffic the parent happens to send.
 *
 * Pure, and handed the frame's own facts rather than reading `window`, so the
 * rule can be tested without a browser.
 */
export function isFromHost(
  event: { origin: string; source: unknown; data: unknown },
  frame: { parent: unknown; ownOrigin: string; hostOrigins: readonly string[] },
): boolean {
  if (event.origin !== frame.ownOrigin && !frame.hostOrigins.includes(event.origin)) return false;
  if (event.source === null || event.source !== frame.parent) return false;

  const data = event.data as { source?: unknown } | null;
  return data?.source === SOURCE.host;
}
