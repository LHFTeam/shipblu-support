import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit talks to the database directly for `generate`/`push`, so it uses
 * the session connection rather than the transaction pooler.
 */
/**
 * `generate` only diffs the schema against ./db/migrations and never opens a
 * connection, so a placeholder keeps it runnable without secrets. Commands that
 * do connect (`push`, `studio`, `migrate`) fail loudly against the placeholder.
 */
const url =
  process.env.DATABASE_URL_SESSION ??
  process.env.DATABASE_URL ??
  'postgresql://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
  schema: './db/schema/index.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
