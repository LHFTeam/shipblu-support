import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Runs drizzle migrations, then replays every file in db/sql/.
 *
 * Those files are idempotent by construction, so re-running them after each
 * deploy keeps triggers, functions and expression indexes in sync without
 * hand-editing generated migration files.
 *
 * Uses the session connection: DDL and advisory locks do not belong on the
 * transaction pooler.
 */

const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_SESSION or DATABASE_URL must be set');
  process.exit(1);
}

/**
 * How long a statement will wait for a lock before giving up.
 *
 * The post-migration files drop and recreate triggers, which needs
 * `ACCESS EXCLUSIVE` on the table and therefore waits behind every open
 * transaction touching it — including a *read*. One abandoned connection left
 * mid-transaction by the pooler is enough: on 2026-08-19 two of them sat on
 * `agents` for six hours, and every deploy in between died on
 * `DROP TRIGGER IF EXISTS touch_updated_at ON agents` after burning the full
 * two-minute `statement_timeout`, with an error naming only the timeout.
 *
 * Ten seconds turns that into a fast, legible failure: the deploy still stops —
 * it must, the triggers are not optional — but it stops in seconds saying it
 * could not get a lock, which points at the blocking session instead of at the
 * migration. Long enough to ride out ordinary write traffic, short enough that
 * nobody waits two minutes to be told nothing.
 */
const LOCK_TIMEOUT = '10s';

/**
 * Migrations opt out of the account-wide `transaction_timeout`.
 *
 * That setting exists to reap connections left mid-transaction by the pooler,
 * which otherwise hold their locks indefinitely — two sat on `agents` for six
 * hours on 2026-08-19 and blocked every deploy. It is set on the role, so it
 * applies to this session too, and a migration is the one thing here that
 * legitimately runs long: building an index over a large table can take
 * minutes, and being killed halfway through leaves the deploy failing for a
 * reason that has nothing to do with the migration.
 *
 * A session-level SET overrides the role default, so this is the exemption.
 *
 * `transaction_timeout` is PostgreSQL 17 and later. Setting it on an older
 * server is not a no-op — it fails the statement outright and takes the whole
 * migration with it — so the version is checked first rather than the error
 * swallowed. Production and staging are 17; a contributor on 16 has no
 * role-level timeout to opt out of anyway.
 */
const TRANSACTION_TIMEOUT = '0';
const TRANSACTION_TIMEOUT_MIN_MAJOR = 17;

async function main() {
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });

  try {
    await sql.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT}'`);

    const [version] = await sql<{ major: number }[]>`
      SELECT current_setting('server_version_num')::int / 10000 AS major
    `;
    if ((version?.major ?? 0) >= TRANSACTION_TIMEOUT_MIN_MAJOR) {
      await sql.unsafe(`SET transaction_timeout = '${TRANSACTION_TIMEOUT}'`);
    }

    console.log('Applying drizzle migrations...');
    await migrate(drizzle(sql), { migrationsFolder: path.join(process.cwd(), 'db/migrations') });

    const sqlDir = path.join(process.cwd(), 'db/sql');
    const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      console.log(`Applying ${file}...`);
      const contents = await readFile(path.join(sqlDir, file), 'utf8');
      await sql.unsafe(contents);
    }

    console.log(`Done: ${files.length} post-migration file(s) applied.`);
  } finally {
    await sql.end();
  }
}

/**
 * `55P03` is lock_not_available and `57014` is statement_timeout — the two ways
 * this fails when something else is holding the table rather than when the SQL
 * is wrong. Postgres reports them without naming the session responsible, so
 * the message says where to look.
 */
function isLockFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '55P03' || code === '57014';
}

main().catch((err: unknown) => {
  console.error(err);

  if (isLockFailure(err)) {
    console.error(
      '\nThis is a lock wait, not a broken migration. Something is holding the table —' +
        '\nusually a connection left mid-transaction, which holds its locks until it is' +
        '\nclosed. Find it and clear it, then redeploy:\n' +
        '\n  select pid, state, wait_event, now() - xact_start as age, left(query, 80)' +
        '\n  from pg_stat_activity' +
        "\n  where xact_start < now() - interval '5 minutes' and pid <> pg_backend_pid()" +
        '\n  order by xact_start;\n' +
        '\n  select pg_terminate_backend(<pid>);\n',
    );
  }

  process.exit(1);
});
