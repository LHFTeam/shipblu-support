import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * The transaction-pooler pool is reachable only through db/client.ts, because
 * the admission gate there is what keeps postgres.js from pipelining through
 * Supavisor (§6.91), and a tagged template on the raw pool never passes it.
 * Each refusal below is one line that would put a query on the pool ungated.
 */

const CLIENT = `import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

let pool;
export function getSql() {
  pool ??= globalThis.__shipbluSql ?? postgres(process.env.DATABASE_URL);
  return pool;
}
export const db = drizzle(getSql());
export function databaseProbe() {
  return getSql().unsafe('select 1');
}
`;

const MIGRATE = `import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL_SESSION, { max: 1 });
`;

const TREE = {
  'db/client.ts': CLIENT,
  'db/migrate.ts': MIGRATE,
  'lib/tickets/list.ts':
    "import { db } from '@/db/client';\nexport const list = () => db.select().from(tickets);\n",
  'db/client.test.ts':
    "import postgres from 'postgres';\nimport { db, getSql } from './client';\nconst raw = db.$client;\ngetSql();\n",
  'lib/admin/purge-jobs.db.test.ts':
    "import postgres from 'postgres';\nconst sql = postgres(process.env.TEST_DATABASE_URL);\n",
};

describe('pool-confinement', () => {
  it('passes the owner, the migration runner and tests that reach the pool directly', async () => {
    expect(await runRule('pool-confinement', TREE)).toEqual([]);
  });

  it('refuses a module that imports getSql, and names each line it is used on', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'worker/handlers/sweep.ts':
        "import { getSql } from '@/db/client';\nexport async function sweep() {\n  await getSql()`delete from jobs`;\n}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        rule: 'pool-confinement',
        where: 'worker/handlers/sweep.ts:1',
        message: expect.stringMatching(/names getSql, the raw pool .* admission gate/),
      }),
      expect.objectContaining({ where: 'worker/handlers/sweep.ts:3' }),
    ]);
  });

  it('refuses getSql reached through a namespace import', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'lib/reports/raw.ts':
        "import * as client from '@/db/client';\nexport const q = () => client.getSql()`select 1`;\n",
    });

    expect(found).toEqual([expect.objectContaining({ where: 'lib/reports/raw.ts:2' })]);
  });

  it("refuses drizzle's $client, which hands back the same pool", async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'lib/reports/fast.ts':
        "import { db } from '@/db/client';\nexport const q = () => db.$client`select 1`;\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'lib/reports/fast.ts:2',
        message: expect.stringMatching(/\$client, which is the raw pool/),
      }),
    ]);
  });

  it('refuses the pool read off globalThis', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'app/api/debug/route.ts':
        'export async function GET() {\n  await globalThis.__shipbluSql`select 1`;\n  return new Response();\n}\n',
    });

    expect(found).toEqual([expect.objectContaining({ where: 'app/api/debug/route.ts:2' })]);
  });

  it('refuses a second postgres.js pool opened outside db/client.ts', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'lib/search/pool.ts':
        "import postgres from 'postgres';\nexport const sql = postgres(process.env.DATABASE_URL, { max: 4 });\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'lib/search/pool.ts:1',
        message: expect.stringMatching(/imports postgres\.js/),
      }),
    ]);
  });

  it('refuses every road that loads postgres.js as a value, in either quote and down any subpath', async () => {
    // One file per form, so each line the rule names is one form it caught.
    const forms = {
      'scripts/seed.mjs': 'import postgres from "postgres";\n',
      'lib/a/subpath-cf.ts': "import postgres from 'postgres/cf/src/index.js';\n",
      'lib/a/subpath-src.ts': 'import postgres from "postgres/src/index.js";\n',
      'lib/a/named.ts': "import { PostgresError } from 'postgres';\n",
      'lib/a/mixed.ts': "import { type Sql, PostgresError } from 'postgres';\n",
      'lib/a/default-and-type.ts': "import postgres, { type Sql } from 'postgres';\n",
      'lib/a/namespace.ts': "import * as pg from 'postgres';\n",
      'lib/a/side-effect.ts': "import 'postgres';\n",
      'scripts/side-effect.mjs': 'import "postgres/cf/src/index.js";\n',
      'lib/a/empty-braces.ts': "import {} from 'postgres';\n",
      'lib/a/multi-line.ts':
        "export const x = 1;\nimport {\n  PostgresError,\n  type Sql,\n} from 'postgres';\n",
      'lib/a/re-export.ts': 'export { default } from "postgres";\n',
      'lib/a/re-export-star.ts': "export * from 'postgres';\n",
      'lib/a/re-export-ns.ts': "export * as pg from 'postgres/src/index.js';\n",
      'lib/a/dynamic.ts':
        'export async function open() {\n  const { default: postgres } = await import("postgres");\n  return postgres();\n}\n',
      'lib/a/dynamic-template.ts': 'export const load = () => import(`postgres`);\n',
      'scripts/require.mjs':
        "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst postgres = require('postgres');\n",
      'lib/a/require-subpath.ts': 'const postgres = require("postgres/cf/src/index.js");\n',
      'lib/a/import-equals.ts': "import postgres = require('postgres');\n",
      'app/(console)/pool.tsx':
        "import postgres from 'postgres';\nexport const Page = () => <p>Don't</p>;\n",
    };

    const found = await runRule('pool-confinement', { ...TREE, ...forms });

    expect(found.map((f) => f.where).sort()).toEqual(
      [
        'scripts/seed.mjs:1',
        'lib/a/subpath-cf.ts:1',
        'lib/a/subpath-src.ts:1',
        'lib/a/named.ts:1',
        'lib/a/mixed.ts:1',
        'lib/a/default-and-type.ts:1',
        'lib/a/namespace.ts:1',
        'lib/a/side-effect.ts:1',
        'scripts/side-effect.mjs:1',
        'lib/a/empty-braces.ts:1',
        'lib/a/multi-line.ts:2',
        'lib/a/re-export.ts:1',
        'lib/a/re-export-star.ts:1',
        'lib/a/re-export-ns.ts:1',
        'lib/a/dynamic.ts:2',
        'lib/a/dynamic-template.ts:1',
        'scripts/require.mjs:3',
        'lib/a/require-subpath.ts:1',
        'lib/a/import-equals.ts:1',
        'app/(console)/pool.tsx:1',
      ].sort(),
    );
    expect(found.every((f) => /imports postgres\.js/.test(f.message))).toBe(true);
  });

  it('passes a type-only import, which opens nothing, and a mention of the package that is not an import', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'lib/a/types.ts': [
        "import type { Sql } from 'postgres';",
        'import type postgres from "postgres";',
        "import type * as pg from 'postgres/src/index.js';",
        "import { type Sql as S, type PostgresError } from 'postgres';",
        "import type pgEq = require('postgres');",
        "export type { Sql as Pool } from 'postgres';",
        'export { type Row } from "postgres";',
        "export type * from 'postgres';",
        "export type Options = import('postgres').Options<{}>;",
        "export type Module = typeof import('postgres');",
        '',
      ].join('\n'),
      'next.config.ts': "export default { serverExternalPackages: ['postgres', 'sharp'] };\n",
      'lib/a/mentions.ts': [
        "// import postgres from 'postgres' would open a second pool.",
        "/* const sql = require('postgres'); */",
        'export const hint = "import postgres from \'postgres\'";',
        "export const where = require.resolve('postgres');",
        "import array from 'postgres-array';",
        "import interval from 'postgres-interval/index.js';",
        "import scoped from '@scope/postgres';",
        'export { array, interval, scoped };',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([]);
  });

  it('does not count the pool named only in a comment', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'lib/tickets/list.ts':
        "import { db } from '@/db/client';\n// Not getSql()`…` or db.$client: neither passes the gate.\nexport const list = () => db.select().from(tickets);\n",
    });

    expect(found).toEqual([]);
  });

  it('fails when db/client.ts no longer declares getSql, rather than checking nothing', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'db/client.ts': CLIENT.replaceAll('getSql', 'openPool'),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'db/client.ts',
        message: expect.stringMatching(/no longer declares getSql/),
      }),
    ]);
  });

  it('fails when db/client.ts no longer loads postgres.js as the rule reads it, rather than seeing no import anywhere', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'db/client.ts': CLIENT.replace(
        "import postgres from 'postgres';",
        "import { open as postgres } from './pool';",
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'db/client.ts',
        message: expect.stringMatching(/does not load postgres\.js as this rule reads it/),
      }),
    ]);
  });

  it('fails when the migration runner it exempts no longer imports postgres.js', async () => {
    const found = await runRule('pool-confinement', {
      ...TREE,
      'db/migrate.ts': "import type { Sql } from 'postgres';\nimport { db } from './client';\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'db/migrate.ts',
        message: expect.stringMatching(/no longer does — remove it from POSTGRES_IMPORTERS/),
      }),
    ]);
  });

  it('fails when the migration runner it exempts no longer exists', async () => {
    const { 'db/migrate.ts': _migrate, ...rest } = TREE;

    expect(await runRule('pool-confinement', rest)).toEqual([
      expect.objectContaining({
        where: 'db/migrate.ts',
        message: expect.stringMatching(/remove it from POSTGRES_IMPORTERS/),
      }),
    ]);
  });
});
