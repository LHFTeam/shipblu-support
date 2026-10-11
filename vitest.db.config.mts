import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * The database tier: `*.db.test.ts`, run against a real, migrated Postgres.
 *
 * Its own variable rather than `DATABASE_URL`, because every test here starts
 * by truncating every table in the database it is pointed at. A developer's
 * `DATABASE_URL` is the database they are working in, and a tier that picked it
 * up would empty it the first time somebody ran `npm run test:db` to see what
 * it did. `lib/testing/db.ts` refuses a URL that is not this one, and one that
 * is not on this machine — there rather than here, because knip loads this file
 * to find its tests, and a config that threw without the variable would fail
 * the dependency check in every job that has no database.
 *
 * One file at a time, because the files share that database: two truncating
 * it in parallel would each delete the rows the other had just written.
 */
const url = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.db.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    fileParallelism: false,
    env: {
      ...(url && { DATABASE_URL: url, DATABASE_URL_SESSION: url }),
      // Long enough for the Zod schema, and a placeholder: nothing a test here
      // signs is ever read by anything outside it.
      APP_SECRET: 'db-test-placeholder-secret-at-least-32-characters',
      // A key the credential tests seal under. A test of a different key sets
      // its own; nothing sealed here is ever opened outside the test that did it.
      WHATSAPP_CREDENTIAL_KEY: 'db-test-placeholder-credential-key-32-characters',
    },
  },
  resolve: {
    alias: {
      '@': resolve(root),
    },
  },
});
