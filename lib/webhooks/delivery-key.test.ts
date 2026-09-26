import { describe, expect, it } from 'vitest';
import { boundedDeliveryKey } from './delivery-key';

/** What both webhooks stored before the hash, kept here as the compatibility target. */
const previous = (joined: string) => joined.slice(0, 500);

/** A real-length WhatsApp message part: `m:` and a wamid, ~60 characters. */
const wamid = (n: number) =>
  `m:wamid.HBgMMjAxMDAwMDAwMDAwFQIAEhgUM0E${String(n).padStart(16, '0')}AA==`;

const batch = (ids: number[]) => ids.map(wamid).sort().join('|');

describe('boundedDeliveryKey', () => {
  it('leaves a key within the limit exactly as the old slice did', () => {
    // A retry straddling the deploy has to hit the row already stored, so a
    // short key must not change by a byte.
    for (const joined of ['e:wamid.E|m:wamid.M', batch([1, 2, 3]), 'x'.repeat(500)]) {
      expect(boundedDeliveryKey(joined)).toBe(previous(joined));
    }
  });

  it('tells apart two long batches that share their first 500 characters', () => {
    // The bug: nine wamids fill the old key, so a batch holding those nine and
    // one more was answered "duplicate" and never processed.
    const first = batch([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const later = batch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.length).toBeGreaterThan(500);
    expect(previous(first)).toBe(previous(later));

    expect(boundedDeliveryKey(first)).not.toBe(boundedDeliveryKey(later));
  });

  it('gives a long batch the same key whatever order its events arrived in', () => {
    const ids = Array.from({ length: 20 }, (_, i) => i);
    expect(boundedDeliveryKey(batch(ids))).toBe(boundedDeliveryKey(batch([...ids].reverse())));
  });

  it('stays within the limit however long the batch', () => {
    const huge = batch(Array.from({ length: 500 }, (_, i) => i));
    expect(boundedDeliveryKey(huge)).toHaveLength(500);
    expect(boundedDeliveryKey(huge)).toMatch(/\|sha256:[0-9a-f]{64}$/);
  });
});
