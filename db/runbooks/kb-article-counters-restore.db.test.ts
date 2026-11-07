import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refuseUnlessDisposable } from '@/lib/testing/db';

/**
 * The way back from the second half of `plans/kb-article-stats.md`, and its
 * way forward again, on the migrated test database, inside one transaction
 * that is rolled back: nothing here outlives the test.
 *
 * The way back is `kb-article-counters-restore.sql`, which the plan runs by
 * hand. What it must produce is the table the first half's build runs against:
 * the three counters back, as 0060 found them, so that build's INSERT, which
 * names every column, succeeds. The way forward is what a later deploy does
 * after it: 0060 again, which Drizzle applies because the runbook deleted its
 * row. After both, the table is what it was before the runbook.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const databaseUrl = process.env.TEST_DATABASE_URL;
const RUNBOOK = 'kb-article-counters-restore.sql';
const TAG = '0060_kb_articles_drop_counters';

/**
 * 0060 as the journal records it. Drizzle stores an entry's `when` as the
 * row's `created_at`, and the runbook names 0060 by that number because it is
 * run by hand and can read nothing. So a 0060 generated again, whose `when`
 * moves, fails here as a stale literal, and the cases that run the runbook are
 * skipped rather than failing on its refusal of 0060's own row as "a migration
 * newer than 0060".
 */
const journal = JSON.parse(
  readFileSync(path.join(root, 'db/migrations/meta/_journal.json'), 'utf8'),
) as { entries: { idx: number; tag: string; when: number }[] };
const dropMigration = journal.entries.find((entry) => entry.tag === TAG);
if (!dropMigration) throw new Error(`no ${TAG} entry in the migration journal`);
const when = dropMigration.when;
const runbookNamesWhen = ((text: string) =>
  text.includes(`created_at > ${when}`) && text.includes(`created_at = ${when}`))(
  readFileSync(path.join(here, RUNBOOK), 'utf8'),
);

/**
 * Every migration after 0060. Once there is one, CI's database has it applied
 * and the runbook refuses, as it must: deleting 0060's row would no longer make
 * a deploy apply it again. The test below then says so in a sentence, and the
 * cases that run the runbook to completion are skipped rather than failing on
 * its exception. The refusal case still runs, and still passes.
 */
const laterMigrations = journal.entries
  .filter((entry) => entry.idx > dropMigration.idx)
  .map((entry) => entry.tag);

/** Why the cases that run the runbook to completion cannot, if they cannot. */
const cannotRunRunbook = laterMigrations.length > 0 || !runbookNamesWhen;

/** The three columns as 0060 found them, and as the runbook must put them back. */
const RESTORED = [
  { column: 'helpful_count', type: 'integer', nullable: 'NO', default: '0' },
  { column: 'unhelpful_count', type: 'integer', nullable: 'NO', default: '0' },
  { column: 'view_count', type: 'integer', nullable: 'NO', default: '0' },
];

/** The work is rolled back with this rather than committed. */
class RolledBack extends Error {}

describe('the kb_articles counters restore runbook', () => {
  let client: postgres.Sql;

  it('names 0060 by the `when` its journal entry carries', () => {
    expect(
      runbookNamesWhen,
      `The runbook does not name ${TAG} as created_at ${when}, the \`when\` its journal ` +
        'entry carries, in both its refusal and its delete. If 0060 was generated again, ' +
        'copy the new `when` into both.',
    ).toBe(true);
  });

  it('is deleted in the PR that adds a migration after 0060', () => {
    expect(
      laterMigrations,
      `A migration after ${TAG} exists, so this runbook can no longer bring the columns ` +
        'back as a way back: Drizzle applies only migrations newer than the newest row. ' +
        `In the PR that adds it, delete db/runbooks/${RUNBOOK} and this test, and write ` +
        'the way back from that state under "The way back from PR 2" in ' +
        'plans/kb-article-stats.md (or record that it is past rolling back).',
    ).toEqual([]);
  });

  beforeAll(() => {
    refuseUnlessDisposable(process.env.DATABASE_URL, databaseUrl);
    client = postgres(databaseUrl!, { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it.skipIf(cannotRunRunbook)(
    "puts the columns back for the first half's INSERT, and the next deploy drops them again",
    async () => {
      const runbook = await readFile(path.join(here, RUNBOOK), 'utf8');
      const drop = await readFile(path.join(root, `db/migrations/${TAG}.sql`), 'utf8');

      const seen: {
        before?: Columns;
        restored?: Columns;
        remaining?: number;
        inserted?: number[];
        forward?: Columns;
        stats?: number;
        statsAfter?: number;
      } = {};

      await client
        .begin(async (tx) => {
          seen.before = await counters(tx);
          seen.stats = await statsRows(tx);

          await tx.unsafe(runbook);
          seen.restored = await counters(tx);
          seen.remaining = one(
            await tx<{ remaining: number }[]>`
              select count(*)::int as remaining from drizzle.__drizzle_migrations
              where created_at = ${when}`,
          ).remaining;

          // The first half's INSERT, as Drizzle writes it: every column named,
          // `default` for the three it was not given.
          const { id: category } = one(
            await tx<{ id: string }[]>`
              insert into kb_categories (name, slug) values ('Shipping', 'restore-runbook')
              returning id`,
          );
          const { id: folder } = one(
            await tx<{ id: string }[]>`
              insert into kb_folders (category_id, name, slug)
              values (${category}, 'Pickups', 'restore-runbook') returning id`,
          );
          const row = one(
            await tx<{ view_count: number; helpful_count: number; unhelpful_count: number }[]>`
              insert into kb_articles
                (folder_id, title, slug, view_count, helpful_count, unhelpful_count)
              values (${folder}, 'Pickups', 'restore-runbook', default, default, default)
              returning view_count, helpful_count, unhelpful_count`,
          );
          seen.inserted = [row.view_count, row.helpful_count, row.unhelpful_count];

          for (const statement of drop.split('--> statement-breakpoint')) {
            if (statement.trim()) await tx.unsafe(statement);
          }
          seen.forward = await counters(tx);
          seen.statsAfter = await statsRows(tx);

          throw new RolledBack();
        })
        .catch((error: unknown) => {
          if (!(error instanceof RolledBack)) throw error;
        });

      expect(seen.before).toEqual([]);
      expect(seen.restored).toEqual(RESTORED);
      expect(seen.remaining).toBe(0);
      expect(seen.inserted).toEqual([0, 0, 0]);
      expect(seen.forward).toEqual(seen.before);
      // Nothing is copied either way: the counts stay in `kb_article_stats`.
      expect(seen.statsAfter).toBe(seen.stats);
    },
  );

  // Run twice, the second run meets the columns it put back. It refuses whole
  // rather than deleting a migration row it no longer has.
  it.skipIf(cannotRunRunbook)('refuses a second run, and changes nothing', async () => {
    const runbook = await readFile(path.join(here, RUNBOOK), 'utf8');
    const seen: { before?: Columns; after?: Columns; refusal?: unknown } = {};

    await client
      .begin(async (tx) => {
        await tx.unsafe(runbook);
        seen.before = await counters(tx);

        await tx
          .savepoint(async (sp) => {
            await sp.unsafe(runbook);
          })
          .catch((error: unknown) => {
            seen.refusal = error;
          });
        seen.after = await counters(tx);

        throw new RolledBack();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RolledBack)) throw error;
      });

    expect(String(seen.refusal)).toContain('already exists');
    expect(seen.after).toEqual(seen.before);
  });

  // Drizzle applies a migration only when it is newer than the newest row, so
  // once anything after 0060 has run, deleting 0060's row would not bring it
  // back. The runbook refuses before it changes anything. On the database CI
  // migrates, that refusal arrives with the PR adding a 0061, which the journal
  // test above turns into a sentence saying what to do.
  it('refuses once a migration newer than 0060 has been applied', async () => {
    const runbook = await readFile(path.join(here, RUNBOOK), 'utf8');
    let refusal: unknown;
    await client
      .begin(async (tx) => {
        await tx`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          values ('later-migration', ${when + 1})`;
        await tx.unsafe(runbook).catch((error: unknown) => {
          refusal = error;
        });
        throw new RolledBack();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RolledBack)) throw error;
      });

    expect(String(refusal)).toContain(`a migration newer than ${TAG}`);
  });
});

type Columns = { column: string; type: string; nullable: string; default: string | null }[];

/** The three counter columns on `kb_articles`, as the catalog describes them. */
async function counters(tx: postgres.TransactionSql): Promise<Columns> {
  return [
    ...(await tx<Columns>`
      select column_name as column, data_type as type, is_nullable as nullable,
             column_default as default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'kb_articles'
        and column_name in ('view_count', 'helpful_count', 'unhelpful_count')
      order by column_name`),
  ];
}

async function statsRows(tx: postgres.TransactionSql): Promise<number> {
  return one(await tx<{ n: number }[]>`select count(*)::int as n from kb_article_stats`).n;
}

/** The one row a query must return. */
function one<T>(rows: readonly T[]): T {
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  return rows[0]!;
}
