import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversationSubcategories,
  conversations,
  ticketRootCauses,
  ticketStatuses,
  ticketSubcategories,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { subcategoryUsage, syncTaxonomy } from './seed';
import { ROOT_CAUSES, allSubcategories } from './taxonomy';

/**
 * The two halves of `seed.ts` that touch the renamed tables, against real
 * Postgres: `subcategoryUsage`, a raw `sql` template over
 * `conversation_subcategories` that only executing it can check after Stage
 * 2.B of `plans/ticket-category-routing.md`, and `syncTaxonomy`, whose
 * reconcile every deploy's seed runs and whose orphan report is the only way
 * a subcategory dropped from the code reaches a person.
 *
 * Every test starts from the baseline, which has already run `syncTaxonomy`
 * once, so each case below is the re-run a deploy makes.
 */

withCleanDatabase();

type ReviewState = (typeof conversationSubcategories.$inferInsert)['reviewState'];

async function ticket(): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel: 'email', statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

/** A fresh ticket filed under `key`, the key frozen from the registry. */
async function filed(
  key: string,
  reviewState: ReviewState,
  source: 'detected' | 'manual' = 'detected',
): Promise<void> {
  const [subcategory] = await db
    .select({ id: ticketSubcategories.id })
    .from(ticketSubcategories)
    .where(eq(ticketSubcategories.key, key));
  await db.insert(conversationSubcategories).values({
    conversationId: await ticket(),
    subcategoryId: subcategory!.id,
    subcategoryKey: key,
    reviewState,
    source,
    confidence: source === 'manual' ? 1 : 0.7,
  });
}

describe('subcategoryUsage', () => {
  it('counts every assignment but a rejected one, under the key frozen on it', async () => {
    await filed('delivery.late', 'auto');
    await filed('delivery.late', 'suggested');
    await filed('delivery.late', 'confirmed');
    await filed('delivery.late', 'confirmed', 'manual');
    await filed('delivery.late', 'rejected');
    await filed('condition.damaged', 'suggested');
    // Thrown out by an agent and nothing else: as unused as a subcategory
    // nobody was ever filed under, which is what the admin page flags.
    await filed('pickup.supplies', 'rejected');
    await filed('pickup.supplies', 'rejected');

    const usage = await subcategoryUsage();

    // Numbers, as the type promises: a bare count(*) arrives from postgres.js
    // as a string, which the admin row would render without complaint and any
    // total over it would concatenate.
    expect(usage).toEqual(
      new Map([
        ['delivery.late', 4],
        ['condition.damaged', 1],
      ]),
    );
    expect(usage.has('pickup.supplies')).toBe(false);
  });

  it('is empty before anything is assigned', async () => {
    // The page keys "never used" off `usage.size`, so an empty answer has to
    // be an empty map rather than one carrying every subcategory at zero.
    expect((await subcategoryUsage()).size).toBe(0);
  });
});

describe('syncTaxonomy', () => {
  it('finds the whole taxonomy present on a seeded database, and nothing orphaned', async () => {
    expect(await syncTaxonomy()).toEqual({
      subcategoriesCreated: 0,
      subcategoriesPresent: allSubcategories().length,
      causesCreated: 0,
      causesPresent: ROOT_CAUSES.length,
      orphanedSubcategoryKeys: [],
      orphanedCauseKeys: [],
    });
    const stored = await db.select({ key: ticketSubcategories.key }).from(ticketSubcategories);
    expect(stored).toHaveLength(allSubcategories().length);
  });

  it('reports a seeded key the code no longer has, and leaves it where it is', async () => {
    // Seeded by an earlier build and since dropped from the code, beside ones
    // an admin made. Only the first is a decision somebody owes: the admin's
    // were never the code's to report.
    await db.insert(ticketSubcategories).values([
      {
        key: 'delivery.by_pigeon',
        area: 'delivery',
        labelEn: 'By pigeon',
        labelAr: 'بالحمام',
        isSystem: true,
      },
      {
        key: 'delivery.by_drone',
        area: 'delivery',
        labelEn: 'By drone',
        labelAr: 'بالدرون',
        audience: 'merchant',
      },
    ]);
    await db.insert(ticketRootCauses).values([
      {
        key: 'courier.lost_map',
        labelEn: 'Lost the map',
        labelAr: 'ضاعت الخريطة',
        owner: 'courier',
        isSystem: true,
      },
      { key: 'hub.flooded', labelEn: 'Flooded', labelAr: 'غرق', owner: 'hub' },
    ]);
    // And one with a ticket behind it, which the restrict FK is protecting.
    await filed('delivery.by_pigeon', 'confirmed', 'manual');

    const outcome = await syncTaxonomy();

    expect(outcome.orphanedSubcategoryKeys).toEqual(['delivery.by_pigeon']);
    expect(outcome.orphanedCauseKeys).toEqual(['courier.lost_map']);
    expect(outcome.subcategoriesCreated).toBe(0);
    expect(outcome.causesCreated).toBe(0);

    const left = await db
      .select({ key: ticketSubcategories.key, isActive: ticketSubcategories.isActive })
      .from(ticketSubcategories)
      .where(inArray(ticketSubcategories.key, ['delivery.by_pigeon', 'delivery.by_drone']));
    expect(left).toHaveLength(2);
    expect(left.every((row) => row.isActive)).toBe(true);
    expect((await subcategoryUsage()).get('delivery.by_pigeon')).toBe(1);
  });

  it("puts back what is missing, keeps an admin's label, and re-asserts what is structural", async () => {
    const supplies = allSubcategories().find((one) => one.key === 'pickup.supplies')!;
    const cause = ROOT_CAUSES[0]!;

    await db.delete(ticketSubcategories).where(eq(ticketSubcategories.key, supplies.key));
    await db.delete(ticketRootCauses).where(eq(ticketRootCauses.key, cause.key));
    await db
      .update(ticketSubcategories)
      .set({ labelEn: 'Running late', labelAr: 'متأخر' })
      .where(eq(ticketSubcategories.key, 'delivery.late'));
    await db
      .update(ticketSubcategories)
      .set({ isSystem: false })
      .where(eq(ticketSubcategories.key, 'delivery.reschedule'));

    const outcome = await syncTaxonomy();

    expect(outcome).toMatchObject({
      subcategoriesCreated: 1,
      subcategoriesPresent: allSubcategories().length - 1,
      causesCreated: 1,
      causesPresent: ROOT_CAUSES.length - 1,
      orphanedSubcategoryKeys: [],
      orphanedCauseKeys: [],
    });

    // Recreated from the code, its audience through the renamed enum, at its
    // place in the picker.
    const [restored] = await db
      .select()
      .from(ticketSubcategories)
      .where(eq(ticketSubcategories.key, supplies.key));
    expect(restored).toMatchObject({
      area: 'pickup',
      labelEn: supplies.labelEn,
      labelAr: supplies.labelAr,
      audience: 'merchant',
      isDetectable: true,
      isSystem: true,
      isActive: true,
      position: supplies.position,
    });
    const [restoredCause] = await db
      .select()
      .from(ticketRootCauses)
      .where(eq(ticketRootCauses.key, cause.key));
    expect(restoredCause).toMatchObject({ owner: cause.owner, isSystem: true, position: 0 });

    const [late] = await db
      .select()
      .from(ticketSubcategories)
      .where(eq(ticketSubcategories.key, 'delivery.late'));
    expect(late).toMatchObject({ labelEn: 'Running late', labelAr: 'متأخر' });

    const [reschedule] = await db
      .select({ isSystem: ticketSubcategories.isSystem })
      .from(ticketSubcategories)
      .where(eq(ticketSubcategories.key, 'delivery.reschedule'));
    expect(reschedule?.isSystem).toBe(true);
  });
});
