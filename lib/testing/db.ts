import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { seedBaseline } from '@/db/baseline';
import { closeDb, db } from '@/db/client';
import { forgetSuggestionSettings } from '@/lib/canned-suggest/settings';
import { forgetCsatSettings } from '@/lib/csat/settings';
import { forgetSubcategoryIds } from '@/lib/subcategorise/apply';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { forgetPresencePolicy } from '@/lib/presence/policy';

/**
 * The database tier's fixture: every test starts from the configuration
 * `npm run db:seed` writes, and from nothing else.
 *
 * Truncated before each test rather than wrapped in a transaction that rolls
 * back. That would be faster, but most code under test reaches the database
 * through the module-level `db`, which a test cannot swap for its own
 * transaction — every statement it ran would commit outside the rollback, and
 * the next test would start from the last one's rows. Code that takes the
 * transaction as an argument can be tested the faster way, and
 * `lib/admin/purge-*.db.test.ts` are.
 *
 * Call it once at the top of a `*.db.test.ts` file. It registers its own hooks,
 * so a test file cannot forget the half that closes the pool.
 */
export function withCleanDatabase(): void {
  beforeEach(async () => {
    await truncateEverything();
    await seedBaseline(() => {});
    forgetDatabaseCaches();
    // Outside `withoutCommentChannelCheck()`'s block every test starts with the
    // CHECK in place, whatever a run killed inside one left behind. A guarded
    // no-op once the constraint exists: one catalog lookup.
    if (!commentCheckDropped) await db.execute(sql.raw(await commentChannelCheck()));
  });

  afterAll(() => closeDb());
}

/**
 * Inside one `describe`: the database as rolling back Stage 1.2 of
 * `plans/ticket-category-routing.md` leaves it, so its tests can hold a comment
 * ticket on its platform's channel. That is the shape `isCommentTicket`'s
 * external-id half and Meta's live-conversation condition exist for, and the
 * CHECK in `db/sql/008_comment_channel_check.sql` refuses it at the insert
 * everywhere else, so without this nothing at the database tier could build one
 * and every reader's half of the test could be deleted with the suite green.
 *
 * It uses the plan's own SQL: the CHECK is dropped by the guarded block the
 * rollback ships, and `moveCommentsBack()` is the channel half of the
 * rollback's step 3, which puts every comment ticket and both its frozen copies
 * back on their platform (the other half points `channel_id` at a platform row,
 * and no test here has a comments row for it to name). A test builds its
 * ticket the way 1.2 files one, moves it back, and then asks the reader — so a
 * rollback that stopped working would fail here too. Most readers held this way
 * are 1.1's, which the rollback leaves deployed. Three came with 1.2 itself —
 * the automation engine's refusal, the out-of-hours sender's requester check
 * and `requesterLocale`'s comment narrowing — so the rollback's step 2 reverts
 * them, and their cases with them; until then they hold the state in which the
 * CHECK is gone and the comments moved back with 1.2 still deployed. The Meta
 * ingest cases build their thread through 1.2's ingest itself, so under step 2
 * the thread is already on its platform and has nothing to move; the plan's
 * step 2 says what changes in them.
 *
 * After the block it empties the tables and replays `008`, emptying first
 * because the CHECK is added VALID and the block's last test leaves a row it
 * refuses. Nothing else in the file sees the CHECK missing: the files run one
 * at a time (`vitest.db.config.mts`), and `withCleanDatabase()` replays `008`
 * before every test outside the block, so a run killed inside one leaves no
 * later fixture unchecked.
 *
 * The restore runs only after a drop that happened. Vitest runs a block's
 * `afterAll` even when its `beforeAll` threw, so after the refusal below it
 * would otherwise truncate the very database that was refused.
 *
 * Call it inside a `describe`, in a file that called `withCleanDatabase()`.
 */
export function withoutCommentChannelCheck(): { moveCommentsBack: () => Promise<number> } {
  beforeAll(async () => {
    refuseUnlessDisposable(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
    await db.execute(sql.raw(DROP_COMMENT_CHANNEL_CHECK));
    commentCheckDropped = true;
  });

  afterAll(async () => {
    if (!commentCheckDropped) return;
    await truncateEverything();
    await db.execute(sql.raw(await commentChannelCheck()));
    commentCheckDropped = false;
  });

  return {
    // How many tickets it moved, so a test can say the rollback happened rather
    // than pass on a ticket that was never on a comment channel.
    moveCommentsBack: async () => {
      let tickets = 0;
      for (const table of ['conversations', 'csat_surveys', 'canned_suggestions']) {
        const moved = await db.execute(
          sql.raw(
            `UPDATE ${table} SET channel = replace(channel::text, '_comment', '')::channel ` +
              `WHERE channel IN ('facebook_comment', 'instagram_comment') RETURNING 1`,
          ),
        );
        if (table === 'conversations') tickets = moved.length;
      }
      return tickets;
    },
  };
}

/** Whether a `withoutCommentChannelCheck()` block has the CHECK dropped right now. */
let commentCheckDropped = false;

let commentChannelCheckSql: Promise<string> | null = null;

/**
 * `db/sql/008_comment_channel_check.sql`, read once: guarded, so replaying it is
 * idempotent. Found from this module rather than the working directory, since
 * every test reads it and vitest runs from wherever the shell is; and a failed
 * read is not kept, so one bad read does not fail every later test with it.
 */
function commentChannelCheck(): Promise<string> {
  commentChannelCheckSql ??= readFile(
    new URL('../../db/sql/008_comment_channel_check.sql', import.meta.url),
    'utf8',
  ).catch((error: unknown) => {
    commentChannelCheckSql = null;
    throw error;
  });
  return commentChannelCheckSql;
}

/**
 * The rollback of Stage 1.3, as the plan gives it: guarded, so it takes no lock
 * once done, and bounded at 3 s as the ADD is.
 */
const DROP_COMMENT_CHANNEL_CHECK = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_comment_channel_matches_external_id'
      AND conrelid = 'conversations'::regclass
  ) THEN
    PERFORM set_config('lock_timeout', '3s', true);
    ALTER TABLE conversations
      DROP CONSTRAINT conversations_comment_channel_matches_external_id;
  END IF;
END $$`;

/**
 * The caches this process holds of rows that were just truncated.
 *
 * A reseed hands out new ids, so a registry cached by the previous test is a set
 * of foreign keys into nothing. The subcategoriser is the one that shows it:
 * its insert fails the `ticket_categories` foreign key, the lifecycle catches
 * and logs the error as it is meant to, and the test sees a ticket that was
 * never subcategorised — a quirk of the fixture, reading as one of the code.
 *
 * Each module-level cache of database rows in `lib/` already has a `forget*`
 * that whatever writes those rows calls; one added later belongs here too.
 */
function forgetDatabaseCaches(): void {
  forgetSubcategoryIds();
  forgetHoursCatalog();
  forgetPresencePolicy();
  forgetSuggestionSettings();
  forgetCsatSettings();
}

/**
 * Every table in `public` rather than a list of them, so a table added later
 * cannot carry one test's rows into the next without anybody editing this.
 *
 * `restart identity` so a ticket's `number` starts where it would on a fresh
 * database. No `cascade`: every table in the schema is already named, so the
 * only thing it could reach is a table outside it, and emptying one of those
 * should fail loudly rather than happen.
 *
 * It refuses a database that is not disposable itself, rather than trusting
 * each caller to have asked first: a vitest `afterAll` runs even when the
 * `beforeAll` that refused threw.
 */
async function truncateEverything(): Promise<void> {
  refuseUnlessDisposable(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
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

// Loopback only, because a tier that truncates every table must never reach a
// shared database: a staging or production URL pasted into TEST_DATABASE_URL
// passes the equality check below, and this is the only thing left between it
// and an empty database. CI satisfies it because its Postgres is a service
// container published on the runner's localhost. If the job ever moves into a
// container of its own and reaches Postgres by service name (`postgres:5432`),
// add that one exact hostname here — never a pattern, and never a way to switch
// the check off from the environment, which would be the first thing set to
// make a failing run pass.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The last word before a truncate, and deliberately stricter than it needs to
 * be for CI: the tier's database must be the one `TEST_DATABASE_URL` named, and
 * it must be on this machine. `vitest.db.config.mts` is what normally ensures
 * the first, but this helper is importable from anywhere, and a unit test that
 * called it would otherwise truncate whatever `DATABASE_URL` said.
 *
 * Given both URLs rather than reading them, so `db.test.ts` can show it refusing
 * without a database to refuse. The rolled-back `purge-*.db.test.ts` files call
 * it too, so a run without the database fails every file rather than skipping
 * some.
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
