import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { ticketCategories } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { STARTER_CATEGORIES } from './registry';
import { syncCategories } from './seed';

/**
 * `syncCategories` against real Postgres. Every test starts from the baseline,
 * which has already run it once, so each case is the re-run production makes
 * when somebody runs `seed_ticket_categories` again.
 */

withCleanDatabase();

/** A CHECK refusing the write, by name — drizzle's own message names only the query. */
const refusedBy = (constraint: string) => ({
  cause: { code: '23514', constraint_name: constraint },
});

async function row(key: string) {
  const [found] = await db.select().from(ticketCategories).where(eq(ticketCategories.key, key));
  return found;
}

describe('syncCategories', () => {
  it('puts in the starter set, in order, with every label and description', async () => {
    const rows = await db.select().from(ticketCategories).orderBy(ticketCategories.position);
    expect(rows.map((r) => r.key)).toEqual(STARTER_CATEGORIES.map((c) => c.key));
    for (const [index, category] of STARTER_CATEGORIES.entries()) {
      expect(rows[index]).toMatchObject({
        labelEn: category.labelEn,
        labelAr: category.labelAr,
        description: category.description,
        position: index,
        isActive: true,
        isSystem: true,
        routeGroupId: null,
      });
    }
  });

  it('changes nothing on a re-run, not even updated_at', async () => {
    const before = await db.select().from(ticketCategories).orderBy(ticketCategories.key);

    expect(await syncCategories()).toEqual({
      created: [],
      present: STARTER_CATEGORIES.length,
      orphaned: [],
    });

    const after = await db.select().from(ticketCategories).orderBy(ticketCategories.key);
    expect(after).toEqual(before);
  });

  it("leaves an admin's edits alone and puts back only a starter category that is missing", async () => {
    await db
      .update(ticketCategories)
      .set({ labelEn: 'New business', position: 9, isActive: false })
      .where(eq(ticketCategories.key, 'sales'));
    await db.delete(ticketCategories).where(eq(ticketCategories.key, 'courier_jobs'));

    const outcome = await syncCategories();

    expect(outcome.created).toEqual(['courier_jobs']);
    expect(await row('sales')).toMatchObject({
      labelEn: 'New business',
      position: 9,
      isActive: false,
    });
    expect((await row('courier_jobs'))?.isSystem).toBe(true);
  });

  it('reports a seeded category the code no longer has, and keeps it', async () => {
    await db.insert(ticketCategories).values({
      key: 'wholesale',
      labelEn: 'Wholesale',
      labelAr: 'الجملة',
      isSystem: true,
    });

    expect((await syncCategories()).orphaned).toEqual(['wholesale']);
    expect(await row('wholesale')).toBeDefined();
  });

  it('refuses a key the CHECK reserves or misshapes', async () => {
    for (const key of ['unknown', 'Sales', 'courier-jobs', '_sales', 'sales__team']) {
      await expect(
        db.insert(ticketCategories).values({ key, labelEn: 'x', labelAr: 'س' }),
        key,
      ).rejects.toMatchObject(refusedBy('ticket_categories_key_format'));
    }
  });

  it('refuses a blank label in either language', async () => {
    await expect(
      db.insert(ticketCategories).values({ key: 'wholesale', labelEn: ' ', labelAr: 'الجملة' }),
    ).rejects.toMatchObject(refusedBy('ticket_categories_labels_not_blank'));
    await expect(
      db.insert(ticketCategories).values({ key: 'wholesale', labelEn: 'Wholesale', labelAr: '' }),
    ).rejects.toMatchObject(refusedBy('ticket_categories_labels_not_blank'));
  });
});
