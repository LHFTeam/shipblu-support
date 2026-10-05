import { eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { cannedResponses, groups } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { CANNED_LIBRARY, librarySeedKey } from '@/lib/tickets/canned-library';
import { withCleanDatabase } from '@/lib/testing/db';
import { seedCannedResponses } from './seed-canned-responses';

/**
 * The starter library's upsert, against real Postgres.
 *
 * The property the job exists for is the second run: it must find what the
 * first one wrote and change nothing, because that is what lets it be re-run
 * to ship a content fix without reverting the team's edits — and "nothing"
 * includes `updated_at`, which `touch_updated_at` moves on any UPDATE at all.
 */

withCleanDatabase();

function job(payload: Record<string, unknown> = {}): ClaimedJob {
  return { id: 'job-1', type: 'seed_canned_responses', payload } as unknown as ClaimedJob;
}

const LIBRARY_SIZE = CANNED_LIBRARY.reduce((sum, folder) => sum + folder.responses.length, 0);
const FIRST = CANNED_LIBRARY[0]!.responses[0]!;

async function seededRows() {
  return db
    .select({
      id: cannedResponses.id,
      seedKey: cannedResponses.seedKey,
      title: cannedResponses.title,
      folder: cannedResponses.folder,
      bodyTextAr: cannedResponses.bodyTextAr,
      bodyHtmlAr: cannedResponses.bodyHtmlAr,
      bodyTextEn: cannedResponses.bodyTextEn,
      bodyHtmlEn: cannedResponses.bodyHtmlEn,
      bodyText: cannedResponses.bodyText,
      bodyHtml: cannedResponses.bodyHtml,
      visibility: cannedResponses.visibility,
      groupId: cannedResponses.groupId,
      usageCount: cannedResponses.usageCount,
      updatedAt: cannedResponses.updatedAt,
    })
    .from(cannedResponses)
    .where(isNotNull(cannedResponses.seedKey));
}

async function rowFor(key: string) {
  const [row] = await db
    .select()
    .from(cannedResponses)
    .where(eq(cannedResponses.seedKey, librarySeedKey(key)));
  return row!;
}

describe('seedCannedResponses', () => {
  it('seeds every response for every agent, in both languages, as text and HTML', async () => {
    await seedCannedResponses(job());

    const rows = await seededRows();
    expect(rows).toHaveLength(LIBRARY_SIZE);

    for (const folder of CANNED_LIBRARY) {
      for (const response of folder.responses) {
        const row = rows.find((one) => one.seedKey === librarySeedKey(response.key));
        expect(row, response.key).toBeDefined();
        expect(row).toMatchObject({
          title: response.title,
          folder: folder.name,
          bodyTextAr: response.ar,
          bodyTextEn: response.en,
          visibility: 'global',
          usageCount: 0,
        });
        // The HTML is what email sends; a blank one would mail an empty reply.
        expect(row!.bodyHtmlAr).toMatch(/^<p>/);
        expect(row!.bodyHtmlEn).toMatch(/^<p>/);
        // And the superseded pair still says something to code that reads it.
        expect(row!.bodyText).toBe(response.ar);
        expect(row!.bodyHtml).toBe(row!.bodyHtmlAr);
      }
    }
  });

  it('finds everything current on a second run and writes nothing, timestamps included', async () => {
    await seedCannedResponses(job());
    const before = await seededRows();

    await seedCannedResponses(job({ overwrite: true }));
    const after = await seededRows();

    expect(after).toHaveLength(before.length);
    for (const row of before) {
      const same = after.find((one) => one.id === row.id);
      expect(same, row.seedKey ?? row.id).toEqual(row);
    }
  });

  it('leaves a response the team edited, and overwrite puts the library text back', async () => {
    await seedCannedResponses(job());

    const support = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.name, 'Support'))
      .limit(1);
    const groupId = support[0]!.id;

    const original = await rowFor(FIRST.key);
    await db
      .update(cannedResponses)
      .set({
        title: 'Our own wording',
        bodyTextEn: 'Reworded by the team.',
        visibility: 'group',
        groupId,
        usageCount: 7,
      })
      .where(eq(cannedResponses.id, original.id));

    await seedCannedResponses(job());
    expect(await rowFor(FIRST.key)).toMatchObject({
      title: 'Our own wording',
      bodyTextEn: 'Reworded by the team.',
    });

    await seedCannedResponses(job({ overwrite: true }));
    expect(await rowFor(FIRST.key)).toMatchObject({
      id: original.id,
      title: FIRST.title,
      bodyTextEn: FIRST.en,
      bodyHtmlEn: original.bodyHtmlEn,
      // What the job never owns after insert: who sees the response, and the
      // count of how often the team has sent it.
      visibility: 'group',
      groupId,
      usageCount: 7,
    });
  });

  it('recognises a renamed response rather than inserting a second copy', async () => {
    await seedCannedResponses(job());
    const original = await rowFor(FIRST.key);

    await db
      .update(cannedResponses)
      .set({ title: 'Renamed for search' })
      .where(eq(cannedResponses.id, original.id));

    await seedCannedResponses(job());

    expect(await seededRows()).toHaveLength(LIBRARY_SIZE);
    expect((await rowFor(FIRST.key)).title).toBe('Renamed for search');
  });

  it('writes nothing on a dry run, whatever else it is asked to do', async () => {
    await seedCannedResponses(job({ dryRun: true }));
    expect(await seededRows()).toHaveLength(0);

    await seedCannedResponses(job());
    const original = await rowFor(FIRST.key);
    await db
      .update(cannedResponses)
      .set({ bodyTextAr: 'نص عدّله الفريق.' })
      .where(eq(cannedResponses.id, original.id));

    await seedCannedResponses(job({ dryRun: true, overwrite: true }));
    expect((await rowFor(FIRST.key)).bodyTextAr).toBe('نص عدّله الفريق.');
  });

  it('brings back a response deleted in the console, which is the documented trade', async () => {
    await seedCannedResponses(job());
    const original = await rowFor(FIRST.key);
    await db.delete(cannedResponses).where(eq(cannedResponses.id, original.id));

    await seedCannedResponses(job());

    expect(await seededRows()).toHaveLength(LIBRARY_SIZE);
  });

  it('leaves the responses people wrote in the console alone', async () => {
    const [mine] = await db
      .insert(cannedResponses)
      .values({ title: 'Written here', bodyTextEn: 'Ours.', bodyHtmlEn: '<p>Ours.</p>' })
      .returning();

    await seedCannedResponses(job({ overwrite: true }));

    const [after] = await db.select().from(cannedResponses).where(eq(cannedResponses.id, mine!.id));
    expect(after).toEqual(mine);
  });
});
