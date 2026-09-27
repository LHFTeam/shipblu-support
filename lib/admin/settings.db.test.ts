import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { cannedResponses, locations, shipmentPhrases, ticketFields } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  listCannedResponses,
  listLocations,
  listSavedPhrases,
  listTicketFields,
  listTicketStatuses,
} from './settings';

/**
 * The admin settings pages' lists: every row, in the order the page shows
 * them, inactive ones included where the table has the flag. An admin edits a
 * retired row from these same pages, so a list that dropped them would leave
 * it uneditable.
 */

withCleanDatabase();

describe('the admin settings lists', () => {
  it('lists canned responses by folder, then title', async () => {
    await db.insert(cannedResponses).values([
      { title: 'Refund', folder: 'Billing' },
      { title: 'Address change', folder: 'Delivery' },
      { title: 'Apology', folder: 'Billing' },
    ]);

    const rows = await listCannedResponses();

    expect(rows.map((row) => row.title)).toEqual(['Apology', 'Refund', 'Address change']);
  });

  it('lists ticket fields by position, then label', async () => {
    await db.insert(ticketFields).values([
      { key: 'warehouse', label: 'Warehouse', type: 'text', position: 2 },
      { key: 'reason', label: 'Reason', type: 'text', position: 1, isActive: false },
      { key: 'area', label: 'Area', type: 'text', position: 1 },
    ]);

    expect((await listTicketFields()).map((row) => row.key)).toEqual([
      'area',
      'reason',
      'warehouse',
    ]);
  });

  it('lists locations by code, with the five columns the page reads', async () => {
    await db.insert(locations).values([
      { name: 'Giza hub', code: 'GIZ', email: 'giza@shipblu.test' },
      { name: 'Alexandria', code: 'ALX', email: 'alex@shipblu.test', isActive: false },
    ]);

    const rows = await listLocations();

    expect(rows.map((row) => row.code)).toEqual(['ALX', 'GIZ']);
    expect(Object.keys(rows[0]!).sort()).toEqual(['code', 'email', 'id', 'isActive', 'name']);
  });

  it('lists the seeded statuses in their position order', async () => {
    expect((await listTicketStatuses()).map((row) => row.name)).toEqual([
      'Open',
      'Pending',
      'Resolved',
      'Closed',
    ]);
  });

  it('lists only the phrases an admin saved', async () => {
    expect(await listSavedPhrases()).toEqual([]);
    await db.insert(shipmentPhrases).values({ key: 'delivered', ar: 'تم التسليم' });

    expect(await listSavedPhrases()).toEqual([{ key: 'delivered', ar: 'تم التسليم' }]);
  });
});
