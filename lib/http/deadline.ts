/**
 * Deadlines for outbound requests, stated once.
 *
 * Every client here passes `AbortSignal.timeout()` to `fetch`, and each kept its
 * own copy of the two pieces below — a formula two modules had to agree on for
 * one file to survive being downloaded and then stored, and a check for the
 * signal's rejection spelled out at every call site. Pure and import-free, so it
 * is safe on either side of the wire.
 */

/**
 * Whether a request failed because its `AbortSignal.timeout()` deadline passed.
 *
 * The signal rejects with a `DOMException` named `TimeoutError` — on the fetch
 * itself and on a body read it governs alike — and its message, "The operation
 * was aborted due to timeout", names no call. Every client turns this into a
 * sentence of its own; this is only the recognising half.
 */
export function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/**
 * How long a transfer of this many bytes may take.
 *
 * A minute for anything, and a second more for every 2 MB — the slowest link
 * this accepts, a choice rather than a measurement. A flat minute gave a 100 MB
 * WhatsApp document up below 1.7 MB/s on every attempt alike, and where nothing
 * retries — email ingest drops an attachment whose upload failed — a slow but
 * working transfer cut short is a file the customer sent and the agent never
 * sees. Scaled rather than simply raised, because a small file that stalls
 * should still be noticed in a minute. 110 seconds at 100 MB.
 *
 * One formula for the download and the upload of the same file, because both
 * halves have to fit inside the queue's reclaim window together — the margin
 * the queue has if the worker's lock heartbeat fails (`WRITE_TIMEOUT_MS`).
 * The WhatsApp client's test adds the whole job up from the real functions —
 * lookup, largest download, and this upload of the same bytes — against
 * `STALLED_AFTER_MS`.
 */
export function sizedTimeout(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (2 * 1024 * 1024)) * 1000;
}

/** A lookup, which a job or a person is waiting on. */
export const READ_TIMEOUT_MS = 15_000;

/**
 * A write, which is usually a message to a customer — a Graph send, or an email
 * through Postmark.
 *
 * The deadline sits in a window with two edges. Below about a minute, a send
 * the provider was still accepting is given up on and retried — a duplicate
 * message. The upper edge, `STALLED_AFTER_MS`, is now only a margin: the worker
 * refreshes a running job's lock, so a live send is reclaimed and run again
 * only if that heartbeat fails for the whole window. A deploy is a separate
 * matter that no deadline governs: a send still waiting when Render's shutdown
 * window runs out (`render.yaml` sets none, so its default) dies with the
 * process, and the sweep runs it again once its lock goes stale.
 *
 * And there has to be one. `fetch` with no signal gives up only after five
 * minutes without a response — never, on a body that keeps trickling in — and
 * the worker refreshes the lock of every job it is running, so nothing else
 * ends it: a request with no deadline holds its worker slot for good, and a
 * handful of them stop the queue. Before the worker refilled slots one at a
 * time, the same request held every queued job behind it.
 */
export const WRITE_TIMEOUT_MS = 90_000;
