import { eq, isNotNull } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { cannedResponses, groups } from '@/db/schema';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { CANNED_LIBRARY, librarySeedKey } from '@/lib/tickets/canned-library';
import { cannedBodyColumns } from '@/lib/tickets/canned-write';
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
const SECOND = CANNED_LIBRARY[0]!.responses[1]!;

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the run printed, through `logger`, which writes with `console.log`. */
function captureLog(): () => string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return () => spy.mock.calls.map((call) => call.join(' ')).join('\n');
}

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

  it('overwrites only the entries keys names, and names each one it replaces', async () => {
    await seedCannedResponses(job());
    for (const response of [FIRST, SECOND]) {
      await db
        .update(cannedResponses)
        .set({ title: `Ours: ${response.key}` })
        .where(eq(cannedResponses.seedKey, librarySeedKey(response.key)));
    }

    const preview = captureLog();
    await seedCannedResponses(job({ dryRun: true, overwrite: true, keys: FIRST.key }));
    expect(preview()).toContain(`replaces: "Ours: ${FIRST.key}" key=${FIRST.key}`);
    expect(preview()).not.toContain(SECOND.key);
    vi.restoreAllMocks();

    const run = captureLog();
    await seedCannedResponses(job({ overwrite: true, keys: FIRST.key }));
    expect(run()).toContain(`replaces: "Ours: ${FIRST.key}" key=${FIRST.key}`);

    // The one fix shipped; the other edit the team made is still theirs.
    expect((await rowFor(FIRST.key)).title).toBe(FIRST.title);
    expect((await rowFor(SECOND.key)).title).toBe(`Ours: ${SECOND.key}`);
  });

  it('refuses a key the library does not have, rather than aiming an overwrite at nothing', async () => {
    await expect(
      seedCannedResponses(job({ overwrite: true, keys: `${FIRST.key},delivery.misspelt` })),
    ).rejects.toThrow(PermanentJobError);
    expect(await seededRows()).toHaveLength(0);
  });

  // The HTML is derived, so a row whose text the team never touched is current
  // whatever `textToHtml` made of it at the time — otherwise a change to that
  // function would read as every seeded response having been edited.
  it('judges a row by what a person writes, never by the HTML derived from it', async () => {
    await seedCannedResponses(job());
    const original = await rowFor(FIRST.key);
    await db
      .update(cannedResponses)
      .set({ bodyHtmlEn: '<p>Rendered by an older textToHtml.</p>' })
      .where(eq(cannedResponses.id, original.id));
    const before = await rowFor(FIRST.key);

    const log = captureLog();
    await seedCannedResponses(job({ overwrite: true }));

    expect(log()).not.toContain('differs:');
    expect(log()).not.toContain('replaces:');
    expect(await rowFor(FIRST.key)).toEqual(before);
  });

  // A seeded response opened and saved in the console unchanged: the browser
  // submits CRLF, and `saveCannedResponse` writes through `cannedBodyColumns`.
  it('finds a seeded response saved back from the console still current', async () => {
    await seedCannedResponses(job());
    const original = await rowFor(SECOND.key);
    await db
      .update(cannedResponses)
      .set(
        cannedBodyColumns({
          ar: SECOND.ar.replace(/\n/g, '\r\n'),
          en: SECOND.en.replace(/\n/g, '\r\n'),
        }),
      )
      .where(eq(cannedResponses.id, original.id));

    const log = captureLog();
    await seedCannedResponses(job());

    expect(log()).not.toContain('differs:');
  });

  it('names a seeded response the library no longer has, and leaves it where it is', async () => {
    const [retired] = await db
      .insert(cannedResponses)
      .values({
        title: 'An old policy',
        seedKey: librarySeedKey('delivery.retired_entry'),
        ...cannedBodyColumns({ ar: 'سياسة قديمة.', en: 'An old policy.' }),
      })
      .returning();

    const log = captureLog();
    await seedCannedResponses(job({ overwrite: true }));

    expect(log()).toContain('not in the library: "An old policy" key=delivery.retired_entry');
    const [after] = await db
      .select()
      .from(cannedResponses)
      .where(eq(cannedResponses.id, retired!.id));
    expect(after).toEqual(retired);
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
