import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { storeDelivery } from './receive';

/**
 * The storage half of every webhook endpoint, against the unique index it
 * depends on. The route tests replace the database, so only here can a
 * duplicate actually collide, and a null id actually fail to.
 */

withCleanDatabase();

const delivery = {
  provider: 'whatsapp',
  channel: 'whatsapp' as const,
  payload: { entry: [] },
  headers: {},
};

describe('storeDelivery', () => {
  it('stores a verified delivery once, and answers null for the redelivery', async () => {
    const first = await storeDelivery({
      ...delivery,
      deliveryId: () => 'm:1',
      signatureVerified: true,
    });
    const again = await storeDelivery({
      ...delivery,
      deliveryId: () => 'm:1',
      signatureVerified: true,
    });

    expect(first).toEqual(expect.any(String));
    expect(again).toBeNull();
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  // The forgery case: an unsigned payload naming a real delivery's id must not
  // take the slot, or the genuine delivery arriving after it is dropped.
  it('files an unverified delivery under no id, so the genuine one still lands', async () => {
    const forged = await storeDelivery({
      ...delivery,
      deliveryId: () => 'm:2',
      signatureVerified: false,
      error: 'no secret matched',
    });
    const genuine = await storeDelivery({
      ...delivery,
      deliveryId: () => 'm:2',
      signatureVerified: true,
    });

    expect(forged).toEqual(expect.any(String));
    expect(genuine).toEqual(expect.any(String));
    const rows = await db
      .select({
        providerEventId: webhookEvents.providerEventId,
        signatureVerified: webhookEvents.signatureVerified,
        error: webhookEvents.error,
      })
      .from(webhookEvents);
    expect(rows).toEqual(
      expect.arrayContaining([
        { providerEventId: null, signatureVerified: false, error: 'no secret matched' },
        { providerEventId: 'm:2', signatureVerified: true, error: null },
      ]),
    );
  });

  it('never reads the id off a delivery that did not verify', async () => {
    const deliveryId = vi.fn((): string | null => {
      throw new TypeError("Cannot read properties of null (reading 'entry')");
    });

    expect(await storeDelivery({ ...delivery, deliveryId, signatureVerified: false })).toEqual(
      expect.any(String),
    );
    expect(deliveryId).not.toHaveBeenCalled();
  });

  it('stores every unverified retry, since a null id collides with nothing', async () => {
    for (let i = 0; i < 3; i++) {
      expect(
        await storeDelivery({ ...delivery, deliveryId: () => 'm:3', signatureVerified: false }),
      ).toEqual(expect.any(String));
    }
    expect(await db.select().from(webhookEvents)).toHaveLength(3);
  });
});
