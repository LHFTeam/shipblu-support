import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversations,
  jobs,
  kbCategories,
  messages,
  shipments,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { knowledgeBaseCounts, locationCounts, recentRuns, shipmentCounts } from './import-status';

/**
 * The import page's counts against Postgres. Three of them are raw SQL, which
 * nothing else runs before production does, and each has a filter the card's
 * whole point rests on: by language, by how a link was made, and by whether a
 * pin was recovered.
 */

withCleanDatabase();

async function conversationId(): Promise<string> {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({ requesterContactId: contact!.id, statusId: status!.id, channel: 'whatsapp' })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('the import page counts', () => {
  // The state the page exists to explain: nothing imported yet. Each count
  // must still come back as a row of zeros, not as no row at all.
  it('answers a row of zeros on an empty database', async () => {
    expect(await knowledgeBaseCounts()).toEqual({
      categories: 0,
      folders: 0,
      articles: 0,
      redirects: 0,
      categories_en: 0,
      articles_en: 0,
      categories_ar: 0,
      articles_ar: 0,
    });
    expect(await shipmentCounts()).toEqual({
      shipments: 0,
      accounts: 0,
      links: 0,
      links_detected: 0,
      account_links: 0,
      unsynced: 0,
    });
    expect(await locationCounts()).toEqual({ candidates: 0, recovered: 0 });
  });

  it('counts knowledge-base categories per language', async () => {
    await db.insert(kbCategories).values([
      { name: 'Delivery', slug: 'delivery', locale: 'en' },
      { name: 'التوصيل', slug: 'delivery', locale: 'ar' },
      { name: 'الإرجاع', slug: 'returns', locale: 'ar' },
    ]);

    expect(await knowledgeBaseCounts()).toMatchObject({
      categories: 3,
      categories_en: 1,
      categories_ar: 2,
    });
  });

  it('counts a shipment still waiting for its first sync as unsynced', async () => {
    await db
      .insert(shipments)
      .values([
        { trackingNumber: '1755021358719' },
        { trackingNumber: '1755021358720', syncState: 'synced' },
      ]);

    expect(await shipmentCounts()).toMatchObject({ shipments: 2, unsynced: 1 });
  });

  it('counts a pin candidate by its raw body, and a recovered one by its meta', async () => {
    const id = await conversationId();
    const pin = JSON.stringify({
      type: 'location',
      location: { latitude: 30.04, longitude: 31.24 },
    });
    await db.insert(messages).values([
      { conversationId: id, direction: 'inbound', rawBody: pin },
      {
        conversationId: id,
        direction: 'inbound',
        rawBody: pin,
        meta: { location: { latitude: 30.04, longitude: 31.24 } },
      },
      { conversationId: id, direction: 'inbound', rawBody: '{"type":"text"}' },
      { conversationId: id, direction: 'inbound', rawBody: null },
    ]);

    expect(await locationCounts()).toEqual({ candidates: 2, recovered: 1 });
  });
});

describe('recentRuns', () => {
  it('lists the last ten runs of one job type, newest first', async () => {
    const base = Date.parse('2026-09-27T12:00:00Z');
    await db.insert(jobs).values([
      ...Array.from({ length: 11 }, (_, i) => ({
        type: 'import_freshdesk_kb',
        createdAt: new Date(base + i * 60_000),
      })),
      { type: 'backfill_shipment_links', createdAt: new Date(base + 60 * 60_000) },
    ]);

    const runs = await recentRuns('import_freshdesk_kb');

    expect(runs).toHaveLength(10);
    expect(runs[0]!.createdAt).toEqual(new Date(base + 10 * 60_000));
    expect(runs[9]!.createdAt).toEqual(new Date(base + 60_000));
  });
});
