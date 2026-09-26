import { createHash } from 'node:crypto';

/**
 * Fitting a derived delivery key into `webhook_events.provider_event_id`.
 *
 * Meta sends no event id with a WhatsApp or Messenger/Instagram delivery, so
 * both webhooks build one by joining every id in the batch. The column is
 * `text`, but it sits in the unique index that answers "duplicate", and a btree
 * entry has a hard size limit — hence a cap, of 500 characters.
 *
 * The cap used to be `.slice(0, 500)`, which is not a key of the batch but of
 * its first few ids: at ~70 characters a wamid part, seven of them fill it. A
 * later batch sharing those seven plus one more message or status rebuilt the
 * same key, was answered "duplicate" with a 200, and was never processed — the
 * index spans the whole table with no expiry, so the collision is permanent.
 *
 * So a key over the limit keeps a readable prefix and ends in a sha256 of the
 * **whole** joined string: stable across redeliveries (the parts are sorted
 * before joining), and different whenever any id anywhere in the batch is.
 *
 * A key within the limit is returned untouched, byte for byte what the old
 * slice produced. That is deliberate: a Meta retry straddling the deploy must
 * still collide with the row already stored, and nearly every real batch is
 * short. Only an over-long batch retried across the deploy is keyed afresh and
 * stored twice, which ingest absorbs — it deduplicates on the message id itself,
 * so the cost is a row and a no-op job, never a second ticket.
 *
 * No part either caller builds starts `sha256:` (they are all a one-letter kind
 * and a colon), so a hashed key cannot equal a short one.
 */

const MAX_DELIVERY_KEY = 500;

const HASH_MARK = '|sha256:';
const HASH_HEX = 64;
const PREFIX = MAX_DELIVERY_KEY - HASH_MARK.length - HASH_HEX;

export function boundedDeliveryKey(joined: string): string {
  if (joined.length <= MAX_DELIVERY_KEY) return joined;
  const digest = createHash('sha256').update(joined, 'utf8').digest('hex');
  return `${joined.slice(0, PREFIX)}${HASH_MARK}${digest}`;
}
