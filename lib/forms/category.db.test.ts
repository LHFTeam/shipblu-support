import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { ticketCategories, ticketForms } from '@/db/schema';
import { NO_CATEGORY } from '@/lib/categories/choices';
import { withCleanDatabase } from '@/lib/testing/db';
import { consoleCategoryChoice, formDefaultCategoryRefusal } from './category';

/**
 * The two early refusals of a category a form will open a ticket with, against
 * Postgres because both answer from the registry row and, for a form's default,
 * from what the form already stores. Every test starts from the baseline's four
 * active starter categories.
 *
 * Neither writes. `createTicket` reads the registry again under a share lock and
 * leaves a retired category off in silence, so these are what turn an admin's or
 * an agent's stale choice into a sentence rather than a ticket quietly filed
 * under nothing.
 */

withCleanDatabase();

const NOBODY = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const UNKNOWN = 'Unknown category';
const RETIRED = 'That category has been retired — choose another';

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  if (!row) throw new Error(`no category ${key}`);
  return row.id;
}

async function retire(key: string): Promise<string> {
  const id = await categoryId(key);
  await db.update(ticketCategories).set({ isActive: false }).where(eq(ticketCategories.id, id));
  return id;
}

async function form(defaultCategoryId: string | null): Promise<string> {
  const [row] = await db
    .insert(ticketForms)
    .values({ slug: 'delivery', nameEn: 'Delivery', defaultCategoryId })
    .returning({ id: ticketForms.id });
  return row!.id;
}

describe('formDefaultCategoryRefusal', () => {
  it('accepts an active category, on a new form and on one holding another', async () => {
    const sales = await categoryId('sales');
    const existing = await form(await categoryId('customer_support'));

    await expect(formDefaultCategoryRefusal(null, sales)).resolves.toBeNull();
    await expect(formDefaultCategoryRefusal(existing, sales)).resolves.toBeNull();
  });

  it('refuses a category that is not there, on a new form and on an existing one', async () => {
    const existing = await form(null);

    await expect(formDefaultCategoryRefusal(null, NOBODY)).resolves.toBe(UNKNOWN);
    await expect(formDefaultCategoryRefusal(existing, NOBODY)).resolves.toBe(UNKNOWN);
  });

  // The editor names a retired default "(retired)" and posts it back, so a save
  // that only fixed a typo in the intro must not fail over it.
  it('keeps a retired category the form already holds', async () => {
    const sales = await categoryId('sales');
    const existing = await form(sales);
    await retire('sales');

    await expect(formDefaultCategoryRefusal(existing, sales)).resolves.toBeNull();
  });

  it.each([
    ['another category', 'customer_support'],
    ['no category', null],
  ])('refuses a retired category as a new choice on a form holding %s', async (_name, held) => {
    const existing = await form(held ? await categoryId(held) : null);
    const sales = await retire('sales');

    await expect(formDefaultCategoryRefusal(existing, sales)).resolves.toBe(RETIRED);
  });

  it('refuses a retired category on a form not yet saved, which holds nothing to keep', async () => {
    // A form defaulting to the retired category already exists, so the refusal
    // is about the new form holding nothing, not about no form anywhere naming it.
    const sales = await categoryId('sales');
    await form(sales);
    await retire('sales');

    await expect(formDefaultCategoryRefusal(null, sales)).resolves.toBe(RETIRED);
  });

  it('lets null clear a default, even one since retired', async () => {
    const existing = await form(await categoryId('sales'));
    await retire('sales');

    await expect(formDefaultCategoryRefusal(existing, null)).resolves.toBeNull();
    await expect(formDefaultCategoryRefusal(null, null)).resolves.toBeNull();
  });
});

describe('consoleCategoryChoice', () => {
  // Untouched is `undefined` rather than null: `submitForm` then takes the
  // form's default and credits the form, where null would mean "none".
  it.each([true, false])(
    'leaves an untouched chooser to the form (permission %s)',
    async (canSet) => {
      await expect(consoleCategoryChoice('', canSet)).resolves.toEqual({ categoryId: undefined });
    },
  );

  // The page draws no chooser for this agent, so any value is a request it did
  // not offer — refused whatever it names, before it is read.
  it.each([
    ['none', NO_CATEGORY],
    ['a malformed id', 'not-a-uuid'],
    ['an unknown id', NOBODY],
    ['an active category', 'sales'],
  ])('refuses %s from an agent who may not set a category', async (_name, value) => {
    const raw = value === 'sales' ? await categoryId('sales') : value;

    await expect(consoleCategoryChoice(raw, false)).resolves.toEqual({
      error: "You cannot set a ticket's category",
    });
  });

  it('reads none as no category', async () => {
    await expect(consoleCategoryChoice(NO_CATEGORY, true)).resolves.toEqual({ categoryId: null });
  });

  // A malformed id is Postgres's 22P02 if it reaches a query, which throws out
  // of the action with no state; refused, it is the sidebar's own sentence.
  it.each([
    ['a malformed id', 'not-a-uuid'],
    ['a well-formed id naming nothing', NOBODY],
  ])('refuses %s as an unknown category', async (_name, raw) => {
    await expect(consoleCategoryChoice(raw, true)).resolves.toEqual({ error: UNKNOWN });
  });

  it('refuses a retired category', async () => {
    const sales = await retire('sales');

    await expect(consoleCategoryChoice(sales, true)).resolves.toEqual({ error: RETIRED });
  });

  it('passes an active category on as the id', async () => {
    const sales = await categoryId('sales');

    await expect(consoleCategoryChoice(sales, true)).resolves.toEqual({ categoryId: sales });
  });

  // Postgres finds the row either way, but the id travels on through
  // `submitForm` to `createTicket`, and a comparison in code anywhere along the
  // way agrees with the column only in the column's spelling.
  it('passes an id typed in capitals on lower-cased', async () => {
    const sales = await categoryId('sales');

    await expect(consoleCategoryChoice(sales.toUpperCase(), true)).resolves.toEqual({
      categoryId: sales,
    });
  });
});
