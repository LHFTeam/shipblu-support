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

async function main() {
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });

  try {
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

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
