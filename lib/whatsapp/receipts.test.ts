import { describe, expect, it } from 'vitest';
import { lostReceiptNote } from './receipts';

const sent = {
  direction: 'outbound' as const,
  deliveryStatus: 'sent',
  meta: { wamid: null, wamidLost: true },
};

describe('lostReceiptNote', () => {
  it('explains a send whose wamid was lost', () => {
    expect(lostReceiptNote(sent)).toMatch(/receipts will not arrive/);
  });

  it('says nothing about a send with its wamid', () => {
    expect(lostReceiptNote({ ...sent, meta: { wamid: 'wamid.1' } })).toBeNull();
  });

  // A row that later failed carries its own reason, and a lost-receipt note
  // beside "Not delivered" would contradict it.
  it('says nothing once the row has failed', () => {
    expect(lostReceiptNote({ ...sent, deliveryStatus: 'failed' })).toBeNull();
  });

  it('says nothing about an inbound message, whatever its meta holds', () => {
    expect(lostReceiptNote({ ...sent, direction: 'inbound' })).toBeNull();
  });

  // jsonb read back from the row: only a real `true` counts.
  it('ignores a truthy value that is not true', () => {
    expect(lostReceiptNote({ ...sent, meta: { wamidLost: 'true' } })).toBeNull();
    expect(lostReceiptNote({ ...sent, meta: null })).toBeNull();
  });
});
