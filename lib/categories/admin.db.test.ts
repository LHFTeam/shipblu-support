import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { groups, ticketCategories } from '@/db/schema';
import { deleteGroupIfUnused } from '@/lib/admin/group-uses';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { createCategory, ROUTE_GROUP_GONE, setCategoryActive, updateCategory } from './admin';

/**
 * The Categories page's writes against real Postgres. Every test starts from
 * the baseline, which holds the four starter categories and the Support group.
 */

withCleanDatabase();

const NOBODY = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const NEW = {
  key: 'wholesale',
  labelEn: 'Wholesale',
  labelAr: 'الجملة',
  description: '',
  position: 4,
  routeGroupId: null,
};

async function row(key: string) {
  const [found] = await db.select().from(ticketCategories).where(eq(ticketCategories.key, key));
  return found;
}

async function group(name: string) {
  const [created] = await db.insert(groups).values({ name }).returning({ id: groups.id });
  return created!.id;
}

describe('createCategory', () => {
  it('adds an active, unseeded category with its labels tidied and a blank description as null', async () => {
    const merchantCare = await group('Merchant Care');

    await expect(
      createCategory({
        ...NEW,
        labelEn: '  Wholesale ',
        labelAr: ' الجملة ',
        description: '   ',
        routeGroupId: merchantCare,
      }),
    ).resolves.toBeNull();

    expect(await row('wholesale')).toMatchObject({
      labelEn: 'Wholesale',
      labelAr: 'الجملة',
      description: null,
      position: 4,
      routeGroupId: merchantCare,
      isActive: true,
      isSystem: false,
    });
  });

  it('keeps a description, trimmed', async () => {
    await createCategory({ ...NEW, description: ' Bulk orders from one sender. ' });
    expect((await row('wholesale'))?.description).toBe('Bulk orders from one sender.');
  });

  it.each([
    'Wholesale',
    'whole-sale',
    'whole sale',
    '_wholesale',
    'wholesale_',
    'whole__sale',
    'b2b',
    '',
  ])('refuses the key %j as typed, without tidying it into shape', async (key) => {
    await expect(createCategory({ ...NEW, key })).resolves.toBe(
      'The key is lowercase words joined by underscores, such as merchant_support',
    );
    expect(await db.select().from(ticketCategories)).toHaveLength(4);
  });

  it('refuses unknown, which Jev answers for none of these', async () => {
    await expect(createCategory({ ...NEW, key: 'unknown' })).resolves.toMatch(/Jev/);
    expect(await row('unknown')).toBeUndefined();
  });

  it('refuses a key another category holds, naming it', async () => {
    await expect(createCategory({ ...NEW, key: 'sales' })).resolves.toBe(
      'The key sales already belongs to “Sales”',
    );
  });

  it('points at restoring when the holder is retired', async () => {
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.key, 'sales'));

    await expect(createCategory({ ...NEW, key: 'sales' })).resolves.toMatch(/retired — restore it/);
  });

  it.each([
    ['English', { labelEn: '   ' }],
    ['Arabic', { labelAr: '' }],
  ])('refuses a blank %s label', async (_language, labels) => {
    await expect(createCategory({ ...NEW, ...labels })).resolves.toBe(
      'Both the English and the Arabic label are required',
    );
    expect(await row('wholesale')).toBeUndefined();
  });

  it('refuses a position the column cannot hold', async () => {
    await expect(createCategory({ ...NEW, position: 3_000_000_000 })).resolves.toMatch(/position/);
    expect(await row('wholesale')).toBeUndefined();
  });

  it('refuses a route group that does not exist, rather than letting the foreign key throw', async () => {
    await expect(createCategory({ ...NEW, routeGroupId: NOBODY })).resolves.toBe(ROUTE_GROUP_GONE);
    expect(await row('wholesale')).toBeUndefined();
  });
});

describe('updateCategory', () => {
  it('saves the labels, description, position and route group, and never the key', async () => {
    const sales = (await row('sales'))!;
    const inbound = await group('Inbound Sales Team');

    await expect(
      updateCategory(sales.id, {
        // Smuggled in as a caller might from a form: the function takes no key,
        // so nothing reads it.
        ...({ key: 'new_business' } as object),
        labelEn: 'New business',
        labelAr: 'عملاء جدد',
        description: 'Prices and sign-up.',
        position: 9,
        routeGroupId: inbound,
      }),
    ).resolves.toBeNull();

    expect(await row('sales')).toMatchObject({
      id: sales.id,
      labelEn: 'New business',
      labelAr: 'عملاء جدد',
      description: 'Prices and sign-up.',
      position: 9,
      routeGroupId: inbound,
    });
    expect(await row('new_business')).toBeUndefined();
  });

  it('clears the route group and the description', async () => {
    const sales = (await row('sales'))!;
    const inbound = await group('Inbound Sales Team');
    await db
      .update(ticketCategories)
      .set({ routeGroupId: inbound })
      .where(eq(ticketCategories.id, sales.id));

    await updateCategory(sales.id, {
      labelEn: sales.labelEn,
      labelAr: sales.labelAr,
      description: '',
      position: sales.position,
      routeGroupId: null,
    });

    expect(await row('sales')).toMatchObject({ routeGroupId: null, description: null });
  });

  it('writes nothing when nothing changed, not even updated_at', async () => {
    const before = (await row('sales'))!;

    await expect(
      updateCategory(before.id, {
        labelEn: before.labelEn,
        labelAr: before.labelAr,
        description: before.description ?? '',
        position: before.position,
        routeGroupId: before.routeGroupId,
      }),
    ).resolves.toBeNull();

    expect((await row('sales'))?.updatedAt).toEqual(before.updatedAt);
  });

  it('refuses a category that is not there', async () => {
    await expect(updateCategory(NOBODY, { ...NEW, description: '' })).resolves.toMatch(
      /no longer exists/,
    );
  });

  it('refuses a blank label and an unknown group, changing nothing', async () => {
    const before = (await row('sales'))!;
    const edit = {
      labelEn: 'New business',
      labelAr: before.labelAr,
      description: '',
      position: 0,
      routeGroupId: null,
    };

    await expect(updateCategory(before.id, { ...edit, labelAr: ' ' })).resolves.toBe(
      'Both the English and the Arabic label are required',
    );
    await expect(updateCategory(before.id, { ...edit, routeGroupId: NOBODY })).resolves.toBe(
      ROUTE_GROUP_GONE,
    );
    expect(await row('sales')).toEqual(before);
  });
});

describe('setCategoryActive', () => {
  it('retires and restores, and never deletes', async () => {
    const sales = (await row('sales'))!;

    await expect(setCategoryActive(sales.id, false)).resolves.toBeNull();
    expect((await row('sales'))?.isActive).toBe(false);

    await expect(setCategoryActive(sales.id, true)).resolves.toBeNull();
    expect((await row('sales'))?.isActive).toBe(true);
  });

  it('writes nothing when the category already is what was asked, and says nothing is wrong', async () => {
    const before = (await row('sales'))!;

    await expect(setCategoryActive(before.id, true)).resolves.toBeNull();
    expect((await row('sales'))?.updatedAt).toEqual(before.updatedAt);

    await setCategoryActive(before.id, false);
    const retired = (await row('sales'))!;
    expect(retired.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

    await expect(setCategoryActive(before.id, false)).resolves.toBeNull();
    expect((await row('sales'))?.updatedAt).toEqual(retired.updatedAt);
  });

  it('refuses a category that is not there', async () => {
    await expect(setCategoryActive(NOBODY, false)).resolves.toMatch(/no longer exists/);
  });
});

/**
 * The route group's lock, against `deleteGroupIfUnused` taking the group's
 * own. Run one after the other these pass whatever the code does, so each holds
 * one writer open, with every lock it took, while the other starts.
 */
describe('a route group and a delete of it at the same moment', () => {
  it('answers a group deleted while the save waited on it as gone, not with a foreign-key error', async () => {
    const doomed = await group('Doomed');
    const hold = holdNextTransaction('after');
    const deleting = deleteGroupIfUnused(doomed);
    await hold.atHold;

    const creating = createCategory({ ...NEW, routeGroupId: doomed });
    await untilWaitingOnALock(db);
    hold.release();

    await expect(deleting).resolves.toBeNull();
    await expect(creating).resolves.toBe(ROUTE_GROUP_GONE);
    expect(await row('wholesale')).toBeUndefined();
  });

  it('makes a delete that starts after the save wait for it, and then refuse', async () => {
    const merchantCare = await group('Merchant Care');
    const hold = holdNextTransaction('after');
    const creating = createCategory({ ...NEW, routeGroupId: merchantCare });
    await hold.atHold;

    const deleting = deleteGroupIfUnused(merchantCare);
    await untilWaitingOnALock(db);
    hold.release();

    await expect(creating).resolves.toBeNull();
    await expect(deleting).resolves.toMatch(/Wholesale/);
    expect((await row('wholesale'))?.routeGroupId).toBe(merchantCare);
  });
});
