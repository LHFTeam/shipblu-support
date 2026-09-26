import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, fail, lineOf } from '../lib.mjs';

export function checkPostMigrationSql() {
  const rule = 'db-sql';
  const dir = path.join(ROOT, 'db/sql');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

  for (const file of files) {
    const rel = `db/sql/${file}`;
    const contents = readFileSync(path.join(dir, file), 'utf8');
    // Comments explain these rules in place; stripping them keeps the prose from
    // matching as if it were a statement.
    const code = contents.replace(/--[^\n]*/g, '');

    for (const match of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/gi)) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE INDEX CONCURRENTLY cannot run inside a transaction, and db/migrate.ts sends each file as one',
      );
    }

    for (const match of code.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY|IF\s+NOT\s+EXISTS)/gi,
    )) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE INDEX without IF NOT EXISTS — this file is replayed after every migration and must be idempotent',
      );
    }
    for (const match of code.matchAll(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE TABLE without IF NOT EXISTS — and a table belongs in db/schema/ plus a generated migration, not here',
      );
    }
    for (const match of code.matchAll(/CREATE\s+FUNCTION\s/gi)) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE FUNCTION without OR REPLACE — this file is replayed after every migration',
      );
    }
    for (const match of code.matchAll(/CREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      fail(rule, `${rel}:${lineOf(code, match.index)}`, 'CREATE EXTENSION without IF NOT EXISTS');
    }
  }

  /**
   * RLS is enabled by a loop over `public`, deliberately, because a list has the
   * same gap one table later — seven tables reached production readable and
   * writable with the anon key that ships in client bundles. A hand-written
   * ALTER TABLE ... ENABLE ROW LEVEL SECURITY means somebody has started
   * maintaining that list again.
   */
  for (const file of files) {
    const contents = readFileSync(path.join(dir, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const match of contents.matchAll(
      /ALTER\s+TABLE\s+(?!public\.%I)[^\n;]*ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      fail(
        rule,
        `db/sql/${file}:${lineOf(contents, match.index)}`,
        'RLS is enabled by the loop over public in db/sql — do not enable it table by table, a list has the same gap one table later',
      );
    }
  }
}
