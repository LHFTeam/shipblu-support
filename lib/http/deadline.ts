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
 * halves have to fit inside the queue's reclaim window together; the WhatsApp
 * client's test computes that sum from the real functions.
 */
export function sizedTimeout(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (2 * 1024 * 1024)) * 1000;
}
