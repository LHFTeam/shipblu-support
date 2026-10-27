import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  forgetCategoryAiSettings,
  loadCategoryAiSettings,
  readCategoryAiSettings,
  saveCategoryAiSettings,
} from './settings';

/**
 * The classifier's one-row settings: what a fresh install reads, what the
 * admin's save writes, and the difference between the memo the enqueue path
 * reads and the row the job and the admin page read.
 */

withCleanDatabase();

describe('the category classifier settings', () => {
  it('read as off, with the column defaults, before anybody has saved', async () => {
    expect(await readCategoryAiSettings()).toEqual({
      mode: 'off',
      minProbability: 0.6,
      routingWindowMinutes: 5,
      changedAt: null,
      changedBy: null,
    });
  });

  it('save one row, and say who saved it', async () => {
    const [mona] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test' })
      .returning({ id: agents.id });

    await saveCategoryAiSettings(
      { mode: 'shadow', minProbability: 0.7, routingWindowMinutes: 3 },
      mona!.id,
    );
    await saveCategoryAiSettings(
      { mode: 'apply', minProbability: 0.8, routingWindowMinutes: 4 },
      mona!.id,
    );

    expect(await readCategoryAiSettings()).toMatchObject({
      mode: 'apply',
      minProbability: 0.8,
      routingWindowMinutes: 4,
      changedBy: 'Mona',
    });
    const [{ rows }] = (await db.execute(
      sql`select count(*)::int as rows from category_ai_settings`,
    )) as unknown as [{ rows: number }];
    expect(rows).toBe(1);
  });

  // Another web instance's save, or the worker's view of this one's: the memo
  // holds what it read for thirty seconds, which is what switching off costs.
  it('memoise for the enqueue path, and read the row as it stands for everything else', async () => {
    forgetCategoryAiSettings();
    expect((await loadCategoryAiSettings()).mode).toBe('off');
    await db.execute(sql`insert into category_ai_settings (id, mode) values (1, 'apply')`);

    expect((await loadCategoryAiSettings()).mode).toBe('off');
    expect((await readCategoryAiSettings()).mode).toBe('apply');
    forgetCategoryAiSettings();
    expect((await loadCategoryAiSettings()).mode).toBe('apply');
  });
});
