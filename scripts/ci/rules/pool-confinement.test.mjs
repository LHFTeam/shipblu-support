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
