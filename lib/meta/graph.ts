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
 */
const GRAPH_VERSION = 'v23.0';

export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Instagram Login's own host. Same version, same paths, different origin and a
 * different credential — see `endpoint` in `lib/meta/client.ts`.
 */
export const INSTAGRAM_GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;

/** A lookup, which a job or a person is waiting on. */
const READ_TIMEOUT_MS = 15_000;

/**
 * A write, which for Graph is usually a message to a customer.
 *
 * The deadline sits in a window with two edges. Below about a minute, a send
 * Meta was still accepting is given up on and retried — a duplicate message.
 * Past `STALLED_AFTER_MS`, a worker restarted while the send hangs has the job
 * reclaimed and run again — the same duplicate by another route. And there has
 * to be one: the worker awaits a whole batch before it claims the next, so a
 * request that never answers stops every queued job.
 */
const WRITE_TIMEOUT_MS = 90_000;

/** How long a Graph call of this method may take before the caller gives up. */
export function graphTimeout(method: 'GET' | 'POST' | 'DELETE'): number {
  return method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}
