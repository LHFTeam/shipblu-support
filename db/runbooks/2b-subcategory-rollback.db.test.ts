import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refuseUnlessDisposable } from '@/lib/testing/db';

/**
 * Stage 2.B's way back and its way forward again, on the migrated test database,
 * inside one transaction that is rolled back: nothing here outlives the test,
 * and no other file sees the old names.
 *
 * The way back is `2b-subcategory-rollback.sql`, the runbook the plan's rollback
 * runs by hand. What it must produce is production's catalog as it stood before
 * 2.B, read on 2026-10-23 and written out below rather than derived, because
 * the whole point of the runbook is that the 2.A code finds every name it
 * expects. The way forward is what a later deploy of `main` does after it:
 * migration 0046 again (the runbook deletes its row, so Drizzle applies it
 * again) and `db/sql/002_subcategories.sql`, which on that database is the
 * production path, renaming CHECKs and primary keys in place rather than
 * creating them. After both, every name must be what it was before the runbook.
 *
 * The tables are found by OID, which a rename keeps, so one snapshot describes
 * them under either set of names.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const databaseUrl = process.env.TEST_DATABASE_URL;

/** Production, read 2026-10-23 before Stage 2.B, by table. */
const PRODUCTION_BEFORE: Snapshot = {
  types: ['category_audience', 'category_review_state'],
  tables: {
    ai_category_runs: {
      columns: [],
      constraints: [
        'ai_category_runs_conversation_id_conversations_id_fk',
        'ai_category_runs_message_id_messages_id_fk',
        'ai_category_runs_pkey',
      ],
      indexes: [
        'ai_category_runs_conversation_idx',
        'ai_category_runs_label_idx',
        'ai_category_runs_label_message_idx',
        'ai_category_runs_pkey',
      ],
    },
    category_metrics_daily: {
      columns: ['category_key'],
      constraints: ['category_metrics_daily_pkey'],
      indexes: [
        'category_metrics_daily_area_idx',
        'category_metrics_daily_day_idx',
        'category_metrics_daily_dimensions_idx',
        'category_metrics_daily_pkey',
      ],
    },
    conversation_categories: {
      columns: ['category_id', 'category_key'],
      constraints: [
        'conversation_categories_assigned_by_agent_id_agents_id_fk',
        'conversation_categories_category_id_ticket_categories_id_fk',
        'conversation_categories_confidence_range',
        'conversation_categories_conversation_id_category_id_pk',
        'conversation_categories_conversation_id_conversations_id_fk',
        'conversation_categories_detected_in_message_id_messages_id_fk',
        'conversation_categories_manual_is_certain',
        'conversation_categories_rejected_not_primary',
        'conversation_categories_reviewed_by_agent_id_agents_id_fk',
      ],
      indexes: [
        'conversation_categories_category_idx',
        'conversation_categories_conversation_id_category_id_pk',
        'conversation_categories_key_idx',
        'conversation_categories_primary_idx',
        'conversation_categories_review_idx',
      ],
    },
    ticket_categories: {
      columns: [],
      constraints: [
        'ticket_categories_area_matches_key',
        'ticket_categories_key_shape',
        'ticket_categories_no_self_merge',
        'ticket_categories_pkey',
      ],
      indexes: [
        'ticket_categories_active_idx',
        'ticket_categories_area_idx',
        'ticket_categories_key_idx',
        'ticket_categories_pkey',
      ],
    },
  },
};

type TableNames = { columns: string[]; constraints: string[]; indexes: string[] };
type Snapshot = { types: string[]; tables: Record<string, TableNames> };

/** The rollback's work is rolled back with this rather than committed. */
class RolledBack extends Error {}

describe('the Stage 2.B rollback runbook', () => {
  let client: postgres.Sql;

  beforeAll(() => {
    refuseUnlessDisposable(process.env.DATABASE_URL, databaseUrl);
    client = postgres(databaseUrl!, { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it('puts back every name production had, and the next deploy puts the new ones back', async () => {
    const runbook = await readFile(path.join(here, '2b-subcategory-rollback.sql'), 'utf8');
    const migration = await readFile(
      path.join(root, 'db/migrations/0046_subcategory_names.sql'),
      'utf8',
    );
    const postMigration = await readFile(path.join(root, 'db/sql/002_subcategories.sql'), 'utf8');

    const seen: {
      before?: Snapshot;
      rolledBack?: Snapshot;
      forward?: Snapshot;
      rowsBefore?: number[];
      rowsAfter?: number[];
    } = {};

    await client
      .begin(async (tx) => {
        const { tables, types } = one(
          await tx<{ tables: number[]; types: number[] }[]>`
          select array[
                   'public.ticket_subcategories'::regclass::oid,
                   'public.conversation_subcategories'::regclass::oid,
                   'public.subcategory_metrics_daily'::regclass::oid,
                   'public.ai_subcategory_runs'::regclass::oid
                 ]::int[] as tables,
                 array[
                   'public.subcategory_audience'::regtype::oid,
                   'public.subcategory_review_state'::regtype::oid
                 ]::int[] as types`,
        );

        seen.before = await snapshot(tx, tables, types);
        seen.rowsBefore = await counts(tx, tables);

        await tx.unsafe(runbook);
        seen.rolledBack = await snapshot(tx, tables, types);
        const { remaining } = one(
          await tx<{ remaining: number }[]>`
          select count(*)::int as remaining from drizzle.__drizzle_migrations
          where created_at = 1792781241219`,
        );
        expect(remaining).toBe(0);

        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
        await tx.unsafe(postMigration);
        seen.forward = await snapshot(tx, tables, types);
        seen.rowsAfter = await counts(tx, tables);

        throw new RolledBack();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RolledBack)) throw error;
      });

    expect(seen.rolledBack).toEqual(sorted(PRODUCTION_BEFORE));
    expect(seen.forward).toEqual(seen.before);
    // A rename moves no data: the same rows before and after the round trip.
    expect(seen.rowsAfter).toEqual(seen.rowsBefore);
  });
});

/** Every name the stage moves, for the given tables and types, sorted. */
async function snapshot(tx: postgres.TransactionSql, tables: number[], types: number[]) {
  const typeRows = await tx<{ name: string }[]>`
    select typname as name from pg_type where oid = any(${types}::oid[]) order by 1`;
  const rows = await tx<{ table: string; kind: string; name: string }[]>`
    select c.oid::regclass::text as table, 'constraints' as kind, k.conname as name
    from pg_class c join pg_constraint k on k.conrelid = c.oid
    where c.oid = any(${tables}::oid[])
    union all
    select c.oid::regclass::text, 'indexes', i.relname
    from pg_class c join pg_index x on x.indrelid = c.oid join pg_class i on i.oid = x.indexrelid
    where c.oid = any(${tables}::oid[])
    union all
    select c.oid::regclass::text, 'columns', a.attname
    from pg_class c join pg_attribute a on a.attrelid = c.oid
    where c.oid = any(${tables}::oid[]) and a.attnum > 0 and not a.attisdropped
      and a.attname like '%categor%'`;

  const result: Snapshot = { types: typeRows.map((row) => row.name), tables: {} };
  for (const row of rows) {
    const entry = (result.tables[row.table] ??= { columns: [], constraints: [], indexes: [] });
    entry[row.kind as keyof TableNames].push(row.name);
  }
  return sorted(result);
}

/**
 * Every list in code-unit order. Postgres sorts by the database's collation,
 * which under en_US weighs an underscore differently from C, so the order a
 * query returns is not one a literal can be written in.
 */
function sorted(snapshot: Snapshot): Snapshot {
  const tables: Record<string, TableNames> = {};
  for (const [table, names] of Object.entries(snapshot.tables)) {
    tables[table] = {
      columns: [...names.columns].sort(),
      constraints: [...names.constraints].sort(),
      indexes: [...names.indexes].sort(),
    };
  }
  return { types: [...snapshot.types].sort(), tables };
}

/** How many rows each table holds, in the order the OIDs were given. */
async function counts(tx: postgres.TransactionSql, tables: number[]): Promise<number[]> {
  const result: number[] = [];
  for (const oid of tables) {
    const { name } = one(await tx<{ name: string }[]>`select ${oid}::oid::regclass::text as name`);
    result.push(one(await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${name}`)).n);
  }
  return result;
}

/** The one row a query must return. */
function one<T>(rows: readonly T[]): T {
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  return rows[0]!;
}
