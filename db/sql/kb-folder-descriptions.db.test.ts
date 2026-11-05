import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbCategories, kbFolders } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `010_kb_folder_descriptions.sql`, run as `db/migrate.ts` runs it: the file's
 * own text, executed, and executed again.
 *
 * The CI replay proves the statement plans and matches nothing on an empty
 * database. This is the half that needs rows: that each folder is found by its
 * audience as well as its own slug, and that a description already there is
 * never overwritten, by the first run or by the replay every deploy makes.
 */

withCleanDatabase();

const backfill = readFileSync(new URL('./010_kb_folder_descriptions.sql', import.meta.url), 'utf8');

const run = () => db.execute(sql.raw(backfill));

async function category(slug: string, locale: 'ar' | 'en'): Promise<string> {
  const [row] = await db
    .insert(kbCategories)
    .values({ name: slug, slug, locale })
    .returning({ id: kbCategories.id });
  return row!.id;
}

async function folder(
  categoryId: string,
  slug: string,
  description: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(kbFolders)
    .values({ categoryId, name: slug, slug, description })
    .returning({ id: kbFolders.id });
  return row!.id;
}

async function descriptionOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ description: kbFolders.description })
    .from(kbFolders)
    .where(eq(kbFolders.id, id));
  return row!.description;
}

describe('010_kb_folder_descriptions.sql', () => {
  it("gives each audience's folder its own line, in either language", async () => {
    const partners = await category('shipblu-partners', 'en');
    const customers = await category('shipblu-customers', 'en');
    const arabic = await category('شركاء-شيب-بلو', 'ar');

    const partnerFaqs = await folder(partners, 'faqs');
    const customerFaqs = await folder(customers, 'faqs');
    const finance = await folder(arabic, 'الماليات');

    await run();

    expect(await descriptionOf(partnerFaqs)).toMatch(/^Accounts, pickups/);
    expect(await descriptionOf(customerFaqs)).toMatch(/^Where a parcel is/);
    expect(await descriptionOf(finance)).toMatch(/^دورة تحويل التحصيلات/);
  });

  it('never overwrites a description that is already there, on any run', async () => {
    const partners = await category('shipblu-partners', 'en');
    const written = await folder(partners, 'financials', 'Written by an editor.');
    const blank = await folder(partners, 'integrations', '   ');

    await run();
    await run();

    expect(await descriptionOf(written)).toBe('Written by an editor.');
    expect(await descriptionOf(blank)).toMatch(/^Connecting a Shopify/);
  });

  it('leaves a folder it does not name alone, and one in another audience', async () => {
    const partners = await category('shipblu-partners', 'en');
    const elsewhere = await category('somebody-else', 'en');

    const unknown = await folder(partners, 'returns');
    const sameSlug = await folder(elsewhere, 'faqs');

    await run();

    expect(await descriptionOf(unknown)).toBeNull();
    expect(await descriptionOf(sameSlug)).toBeNull();
  });
});
