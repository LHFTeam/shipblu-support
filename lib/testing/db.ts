import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { seedBaseline } from '@/db/baseline';
import { closeDb, db } from '@/db/client';
import { forgetCategoryIds } from '@/lib/categorise/apply';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { forgetPresencePolicy } from '@/lib/presence/policy';

/**
 * The database tier's fixture: every test starts from the configuration
 * `npm run db:seed` writes, and from nothing else.
 *
 * Truncated before each test rather than wrapped in a transaction that rolls
 * back. That would be faster, but the code under test reaches the database
 * through the module-level `db`, which a test cannot swap for its own
 * transaction — every statement it ran would commit outside the rollback, and
 * the next test would start from the last one's rows.
 *
 * Call it once at the top of a `*.db.test.ts` file. It registers its own hooks,
 * so a test file cannot forget the half that closes the pool.
 */
export function withCleanDatabase(): void {
  beforeEach(async () => {
    refuseUnlessDisposable(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
    await truncateEverything();
    await seedBaseline(() => {});
    forgetDatabaseCaches();
  });

  afterAll(() => closeDb());
}

/**
 * The caches this process holds of rows that were just truncated.
 *
 * A reseed hands out new ids, so a registry cached by the previous test is a set
 * of foreign keys into nothing. The categoriser is the one that shows it: its
 * insert fails the `ticket_categories` foreign key, the lifecycle catches and
 * logs the error as it is meant to, and the test sees a ticket that was never
 * categorised — a quirk of the fixture, reading as one of the code.
 *
 * Each module-level cache of database rows in `lib/` already has a `forget*`
 * that whatever writes those rows calls; one added later belongs here too.
 */
function forgetDatabaseCaches(): void {
  forgetCategoryIds();
  forgetHoursCatalog();
  forgetPresencePolicy();
}

/**
 * Every table in `public` rather than a list of them, so a table added later
 * cannot carry one test's rows into the next without anybody editing this.
 *
 * `restart identity` so a ticket's `number` starts where it would on a fresh
 * database. No `cascade`: every table in the schema is already named, so the
 * only thing it could reach is a table outside it, and emptying one of those
 * should fail loudly rather than happen.
 */
async function truncateEverything(): Promise<void> {
  const tables = await db.execute<{ name: string }>(
    sql`select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname = 'public'`,
  );
  if (tables.length === 0) {
    throw new Error('the test database has no tables — run `npm run db:migrate` against it first');
  }

  await db.execute(
    sql.raw(`truncate table ${tables.map((t) => t.name).join(', ')} restart identity`),
  );
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The last word before a truncate, and deliberately stricter than it needs to
 * be for CI: the tier's database must be the one `TEST_DATABASE_URL` named, and
 * it must be on this machine. `vitest.db.config.mts` is what normally ensures
 * the first, but this helper is importable from anywhere, and a unit test that
 * called it would otherwise truncate whatever `DATABASE_URL` said.
 *
 * Given both URLs rather than reading them, so `db.test.ts` can show it refusing
 * without a database to refuse.
 */
export function refuseUnlessDisposable(url: string | undefined, testUrl: string | undefined): void {
  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The database tier truncates every table it can reach, ' +
        'so it runs only against a database named for it — a migrated one on this machine.',
    );
  }

  if (url !== testUrl) {
    throw new Error(
      'refusing to truncate: DATABASE_URL is not TEST_DATABASE_URL. Run database tests with `npm run test:db`.',
    );
  }

  // The host only, never the URL: a URL someone pasted by mistake carries its
  // password.
  const { hostname } = new URL(testUrl);
  if (!LOOPBACK.has(hostname)) {
    throw new Error(
      `refusing to truncate a database on ${hostname}: the database tier only runs against one on this machine`,
    );
  }
}
