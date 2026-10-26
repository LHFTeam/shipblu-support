import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { ticketCategories, ticketForms } from '@/db/schema';
import type { Permission } from '@/lib/auth/permissions';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * A form's default category as `saveTicketForm` stores it, against Postgres
 * because what the save may keep is decided by what the form already holds.
 *
 * A retired category is refused as a new choice and kept when it is the
 * form's own: the editor names a retired default "(retired)" and posts it back,
 * so a save that only reworded the intro must not fail over a category retired
 * since. `lib/forms/category.db.test.ts` holds that rule on its own; this holds
 * the action to calling it with the form being saved, and to writing what it
 * accepted. Every test starts from the baseline's four active categories and no
 * forms.
 */

// The real guard's decision, with Next's redirect standing as the throw it is.
vi.mock('@/lib/auth/guard', async () => {
  const { can } =
    await vi.importActual<typeof import('@/lib/auth/permissions')>('@/lib/auth/permissions');
  return {
    requirePermission: async (permission: Permission) => {
      const agent = {
        id: '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44',
        name: 'Mona Admin',
        role: 'admin' as const,
        permissions: {},
      };
      if (!can(agent, permission)) throw new Error(`NEXT_REDIRECT forbidden: ${permission}`);
      return agent;
    },
  };
});
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidated.push(path) }));

const { saveTicketForm } = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };
const NOBODY = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const RETIRED = 'That category has been retired — choose another';

beforeEach(() => {
  revalidated.length = 0;
});

/**
 * What the editor posts for a form that would otherwise save — named, with a
 * slug, asking for the email an anonymous form needs — so the category is the
 * only thing a refusal can be about.
 */
function submission(values: Record<string, string>): FormData {
  const data = new FormData();
  const fields = {
    nameEn: 'Delivery',
    slug: 'delivery',
    elements: JSON.stringify([{ kind: 'system', key: 'requester_email' }]),
    position: '1',
    ...values,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  if (!row) throw new Error(`no category ${key}`);
  return row.id;
}

async function retire(id: string): Promise<void> {
  await db.update(ticketCategories).set({ isActive: false }).where(eq(ticketCategories.id, id));
}

async function existingForm(defaultCategoryId: string | null): Promise<string> {
  const [row] = await db
    .insert(ticketForms)
    .values({
      slug: 'delivery',
      nameEn: 'Delivery',
      descriptionEn: 'Before',
      requiresSignIn: false,
      elements: [{ kind: 'system', key: 'requester_email' }],
      defaultCategoryId,
    })
    .returning({ id: ticketForms.id });
  return row!.id;
}

const forms = () =>
  db
    .select({
      id: ticketForms.id,
      descriptionEn: ticketForms.descriptionEn,
      defaultCategoryId: ticketForms.defaultCategoryId,
    })
    .from(ticketForms);

describe('saveTicketForm, for a form not yet saved', () => {
  it('stores an active default category', async () => {
    const sales = await categoryId('sales');

    expect(await saveTicketForm(INITIAL, submission({ defaultCategoryId: sales }))).toMatchObject({
      error: null,
    });

    expect(await forms()).toEqual([expect.objectContaining({ defaultCategoryId: sales })]);
    expect(revalidated).toEqual(['/admin/forms']);
  });

  // A new form holds nothing to keep, so a retired category is only ever a new
  // choice — and nothing is written, the row included.
  it('refuses a retired category', async () => {
    const sales = await categoryId('sales');
    await retire(sales);

    expect(await saveTicketForm(INITIAL, submission({ defaultCategoryId: sales }))).toEqual({
      error: RETIRED,
    });
    expect(await forms()).toEqual([]);
    expect(revalidated).toEqual([]);
  });

  // Well-formed, so it passes the field's parse and would reach the insert,
  // where the foreign key throws out of the action with no state to show.
  it('refuses an id the registry does not hold, with a sentence', async () => {
    expect(await saveTicketForm(INITIAL, submission({ defaultCategoryId: NOBODY }))).toEqual({
      error: 'Unknown category',
    });
    expect(await forms()).toEqual([]);
    expect(revalidated).toEqual([]);
  });

  // Postgres reads either case as one uuid and spells the column back
  // lower-case, so an upper-case id is the same category and not a refusal.
  it('stores an upper-case spelling of an active category as the category', async () => {
    const sales = await categoryId('sales');

    expect(
      await saveTicketForm(INITIAL, submission({ defaultCategoryId: sales.toUpperCase() })),
    ).toMatchObject({ error: null });
    expect(await forms()).toEqual([expect.objectContaining({ defaultCategoryId: sales })]);
  });
});

describe('saveTicketForm, for a form already saved', () => {
  // The case the rule is for: an admin rewords the intro on a form whose
  // default was retired since, and the editor posts that default back as it
  // stands. Asking about a new form instead would refuse it.
  it('keeps a retired category the form already holds, and saves the rest', async () => {
    const sales = await categoryId('sales');
    const id = await existingForm(sales);
    await retire(sales);

    const saved = await saveTicketForm(
      INITIAL,
      submission({ id, descriptionEn: 'After', defaultCategoryId: sales }),
    );

    expect(saved).toMatchObject({ error: null });
    expect(await forms()).toEqual([{ id, descriptionEn: 'After', defaultCategoryId: sales }]);
    expect(revalidated).toEqual(['/admin/forms']);
  });

  // The column is lower-case whatever was posted, so the comparison with what
  // the form holds has to be made in that spelling or the form's own category
  // reads as a new choice.
  it('keeps the retired category it holds when it is posted in upper case', async () => {
    const sales = await categoryId('sales');
    const id = await existingForm(sales);
    await retire(sales);

    const saved = await saveTicketForm(
      INITIAL,
      submission({ id, descriptionEn: 'After', defaultCategoryId: sales.toUpperCase() }),
    );

    expect(saved).toMatchObject({ error: null });
    expect(await forms()).toEqual([{ id, descriptionEn: 'After', defaultCategoryId: sales }]);
  });

  it('refuses to move it to a retired category, and leaves the form as it was', async () => {
    const support = await categoryId('customer_support');
    const sales = await categoryId('sales');
    const id = await existingForm(support);
    await retire(sales);

    const refused = await saveTicketForm(
      INITIAL,
      submission({ id, descriptionEn: 'After', defaultCategoryId: sales }),
    );

    expect(refused).toEqual({ error: RETIRED });
    expect(await forms()).toEqual([{ id, descriptionEn: 'Before', defaultCategoryId: support }]);
    expect(revalidated).toEqual([]);
  });

  it('refuses an id the registry does not hold, and leaves the form as it was', async () => {
    const support = await categoryId('customer_support');
    const id = await existingForm(support);

    expect(
      await saveTicketForm(
        INITIAL,
        submission({ id, descriptionEn: 'After', defaultCategoryId: NOBODY }),
      ),
    ).toEqual({ error: 'Unknown category' });
    expect(await forms()).toEqual([{ id, descriptionEn: 'Before', defaultCategoryId: support }]);
  });

  // "No default" posts an empty value, which is a choice rather than a field
  // left out — and clears a retired default as readily as an active one.
  it('clears the default when none is chosen', async () => {
    const sales = await categoryId('sales');
    const id = await existingForm(sales);
    await retire(sales);

    expect(await saveTicketForm(INITIAL, submission({ id, defaultCategoryId: '' }))).toMatchObject({
      error: null,
    });
    expect(await forms()).toEqual([expect.objectContaining({ id, defaultCategoryId: null })]);
  });
});
