import { createHash } from 'node:crypto';

/**
 * A Message-ID for a delivery that carried none, derived from its payload.
 *
 * Derived rather than minted from the clock, because ingest's idempotency is
 * keyed on this id. A `process_webhook` run that commits the message and then
 * fails before marking the delivery processed is retried, parses the same
 * stored payload again, and has to arrive at the same id. `Date.now()` handed
 * the retry a new one, which missed the duplicate check and stored the mail a
 * second time.
 *
 * The payload is read back from a `jsonb` column, which keeps its keys in one
 * canonical order, so the same row always stringifies the same way.
 */
export function fallbackMessageId(prefix: string, payload: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(payload) ?? '')
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${digest}`;
}
