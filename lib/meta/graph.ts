import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from '@/lib/http/deadline';

/**
 * The Graph API version every call to Meta addresses, and the two hosts it is
 * addressed on.
 *
 * Declared once rather than once per client. The Messenger and Instagram
 * client, the webhook subscriptions, the permissions diagnostic and the
 * WhatsApp Cloud API client each used to declare `v23.0` for itself, so a
 * version bump was four edits — and a partial one, with some calls on the new
 * version and some on the old, would not announce itself: Graph refuses an edge
 * a version does not have with the same sentence it uses for a deleted object
 * (AGENTS.md, on Graph request shapes). The clients stay separate, each with
 * its own credential and error handling; only the address they share is shared.
 *
 * Before changing it, read the node reference for the version named here for
 * every edge in `docs/meta-endpoints.md`, as AGENTS.md asks.
 *
 * Exported for the one caller that is not a server-side client: the browser's
 * `FB.init` takes the version too, and Embedded Signup's window is opened on
 * it. A popup on one version and an exchange on another is the same partial
 * bump as before, one hop further away. Pure, so the admin page may bundle it.
 */
export const GRAPH_VERSION = 'v23.0';

export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Instagram Login's own host. Same version, same paths, different origin and a
 * different credential — see `endpoint` in `lib/meta/client.ts`.
 */
export const INSTAGRAM_GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;

/**
 * How long a Graph call of this method may take before the caller gives up.
 *
 * The windows themselves live in `lib/http/deadline.ts`, because Postmark's
 * send sits in the same one for the same reasons and used to restate it.
 */
export function graphTimeout(method: 'GET' | 'POST' | 'DELETE'): number {
  return method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}
