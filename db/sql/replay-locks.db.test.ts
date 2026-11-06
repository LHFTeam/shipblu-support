import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * What a replay of `db/sql` locks once it has nothing left to do, which is
 * what a deploy's `npm run db:migrate` does whenever no file has work.
 *
 * `db/migrate.ts` sends each file as one implicit transaction under a 10 s
 * `lock_timeout`, so a statement there that asks for a lock some open
 * transaction holds off fails the deploy. Before it fails it waits, and once
 * granted it holds the lock until the whole file commits, so ordinary traffic
 * queues behind the rest of the file. §6.15 was a `DROP TRIGGER` waiting on an
 * open reader. §6.110 was the eleven `CREATE INDEX IF NOT EXISTS` at the top of
 * `001`, each taking SHARE on its table before finding the index there, so
 * waiting on every open writer. In the same pass `005`'s `ALTER TABLE jobs
 * SET (...)` took SHARE UPDATE EXCLUSIVE on every replay, the lock autovacuum
 * holds.
 *
 * So the rule: in the steady state no file takes a lock stronger than ROW
 * EXCLUSIVE, the lock every INSERT, UPDATE and DELETE takes. Reads, writes and
 * vacuums never hold one off, and nothing a deploy is likely to meet can hold
 * off one of them. It is checked two ways, over every file:
 *
 * - **By the locks a replay holds**, read from `pg_locks` before it commits,
 *   so a failure names the file, the relation and the mode.
 * - **By contention.** Every file is replayed behind one session that holds a
 *   writer's locks and a vacuum's on every relation in the schema, which
 *   together conflict with every mode stronger than ROW EXCLUSIVE. This catches
 *   what the first misses. A lock taken inside a `BEGIN ... EXCEPTION` block
 *   whose statement then failed is released with its subtransaction, before
 *   the snapshot, but it waited all the same. One mode it cannot hold: SHARE
 *   UPDATE EXCLUSIVE on an index, which nothing outside an index's own DDL
 *   can take. So a rename of an index in such a block is missed, and no read
 *   or write waits on that lock anyway. `ALTER INDEX ... SET (...)` takes
 *   ACCESS EXCLUSIVE on the index alone, and is caught.
 *
 * Then each guard is taken out and the same replay fails behind the one
 * stand-in its file used to wait on, then runs once that stand-in has gone.
 * So the stand-in is known to be one the guard avoids, and not one nothing
 * waits on. Last, the guards still do their job when there is something to do,
 * and 001's refuses an index that is there but is not the one it defines.
 *
 * What this cannot show: the database here is the seeded baseline, not
 * production's rows. A guard whose condition reads table data (`IF EXISTS
 * (SELECT ... FROM conversations ...) THEN ALTER ...`) takes nothing here and
 * could still lock on every production deploy. Such a guard needs its own
 * `*.db.test.ts` with the rows that open it, and a production read of what
 * opens it today, as §6.110 records for the backfills.
 */

withCleanDatabase();

const DIR = new URL('./', import.meta.url);
const FILES = readdirSync(DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const read = (file: string) => readFileSync(new URL(file, DIR), 'utf8');

const EXTENSIONS_AND_TRIGGERS = read('001_extensions_and_triggers.sql');
const STORAGE_PARAMETERS = read('005_storage_parameters.sql');

/**
 * Behind a stand-in: a wait this long is a wait on the stand-in. Short, as in
 * the measurement in §6.110. The replays it bounds take no lock autovacuum
 * conflicts with, or are meant to fail.
 */
const BEHIND_A_HOLDER = '1s';

/**
 * With nothing of ours holding anything: `db/migrate.ts`'s own timeout. A
 * statement here with work to do takes SHARE or stronger, which an autovacuum
 * of the table holds off until the waiter has waited `deadlock_timeout`, 1 s
 * by default, and cancels it. That is the same second as `BEHIND_A_HOLDER`, so
 * the short timeout would race it.
 */
const UNHELD = '10s';

/** Each file's guard, as the file spells it. A test fails if one is reworded. */
const INDEX_GUARD = 'IF existing IS NULL THEN';
const OPTIONS_GUARD =
  /IF NOT coalesce\(\s*\(SELECT reloptions @> wanted FROM pg_class[^)]*\),\s*false\s*\) THEN/;

/** A file with its guard replaced by `true`: what it did before §6.110. */
function unguarded(text: string, guard: string | RegExp): string {
  const without = text.replace(guard, 'IF true THEN');
  expect(without, 'the guard this test takes out is not in the file any more').not.toBe(text);
  return without;
}

/** The session holding a lock open, and the one replaying, each a connection of its own. */
let holder: postgres.Sql;
let replayer: postgres.Sql;

beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL!;
  holder = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  replayer = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
});

afterAll(async () => {
  await holder.end({ timeout: 5 });
  await replayer.end({ timeout: 5 });
});

type Refusal = { code?: string; message?: string };

/**
 * Text as `db/migrate.ts` sends a file: one simple query, so one implicit
 * transaction, under `timeout`. The timeout is set for this call, so nothing
 * carries over from an earlier case. Answers the error, or null.
 */
async function replay(text: string, timeout: string): Promise<Refusal | null> {
  await replayer.unsafe(`SET lock_timeout = '${timeout}'`);
  return replayer.unsafe(text).then(
    () => null,
    (error: unknown) => error as Refusal,
  );
}

/** Runs `run` while `holder` keeps `statement`'s locks in an open transaction. */
async function whileHolding<T>(statement: string, run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));

  const transaction = holder.begin(async (tx) => {
    await tx.unsafe(statement);
    held();
    await released;
  });

  await Promise.race([holding, transaction]);
  try {
    return await run();
  } finally {
    release();
    await transaction;
  }
}

/** The kinds of relation the stand-ins below hold: tables, their indexes, and sequences. */
const HELD_KINDS = ['S', 'i', 'r'];

/**
 * A writer on every relation in the schema, and optionally a vacuum on every
 * table: the statements one session runs to hold what they hold.
 *
 * The writer is a write minus the row. An UPDATE matching nothing takes ROW
 * EXCLUSIVE on its table and on every index of it, as a real one does, and
 * fires no row trigger. `LOCK TABLE` would reach no index. A sequence takes
 * ROW EXCLUSIVE from `nextval`, as an INSERT drawing a number does, since
 * `LOCK TABLE` refuses a sequence. A vacuum holds SHARE UPDATE EXCLUSIVE on its
 * table, and ROW EXCLUSIVE on the table's indexes, which the writer already
 * holds. One session can hold both, since the two modes do not conflict.
 */
async function standIn(also: { vacuum: boolean }): Promise<string> {
  const kinds = await holder<{ kind: string }[]>`
    select distinct c.relkind::text as kind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'`;
  // A view, a materialised view or a partitioned table added later is a
  // relation nothing here holds, so a lock on one would go unseen.
  expect(
    kinds.map((k) => k.kind).sort(),
    'a kind of relation the stand-in does not hold is in the schema',
  ).toEqual(HELD_KINDS);

  const tables = await holder<{ name: string; column: string }[]>`
    select format('%I.%I', n.nspname, c.relname) as name,
           (select quote_ident(a.attname) from pg_attribute a
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
              and a.attgenerated = '' and a.attidentity <> 'a'
            order by a.attnum limit 1) as column
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by 1`;
  const sequences = await holder<{ name: string }[]>`
    select format('%I.%I', n.nspname, c.relname) as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
    order by 1`;

  return [
    ...tables.map((t) => `UPDATE ${t.name} SET ${t.column} = ${t.column} WHERE false;`),
    ...sequences.map((s) => `SELECT nextval('${s.name}');`),
    ...(also.vacuum
      ? [`LOCK TABLE ${tables.map((t) => t.name).join(', ')} IN SHARE UPDATE EXCLUSIVE MODE;`]
      : []),
  ].join('\n');
}

/** What a vacuum or an analyze of `jobs` holds, and a `REINDEX CONCURRENTLY` of it. */
const JOBS_VACUUMED = 'LOCK TABLE public.jobs IN SHARE UPDATE EXCLUSIVE MODE';

describe('a replay of db/sql with nothing to do', { timeout: 60_000 }, () => {
  it('takes no lock stronger than a write takes, in any file', async () => {
    const taken: string[] = [];

    for (const file of FILES) {
      // Committed, as `db/migrate.ts` commits it. The locks are read inside the
      // transaction, before the commit releases them.
      const locks = await replayer.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${UNHELD}'`);
        await tx.unsafe(read(file));
        // 16384 is FirstNormalObjectId: a relation created after initdb, so
        // not a catalog. A TOAST table is named by the table it belongs to.
        return tx<{ relation: string; mode: string }[]>`
          select coalesce(owner.oid::regclass::text || ' (TOAST)', l.relation::regclass::text) as relation,
                 l.mode
          from pg_locks l
          left join pg_class owner on owner.reltoastrelid = l.relation
          where l.pid = pg_backend_pid()
            and l.locktype = 'relation'
            and l.relation >= 16384
            and l.mode not in ('AccessShareLock', 'RowShareLock', 'RowExclusiveLock')
          order by 1, 2`;
      });
      taken.push(...locks.map((lock) => `${file}: ${lock.mode} on ${lock.relation}`));
    }

    expect(taken).toEqual([]);
  });

  it('runs every file through behind a writer and a vacuum on every relation', async () => {
    const failed = await whileHolding(await standIn({ vacuum: true }), async () => {
      const failures: string[] = [];
      for (const file of FILES) {
        const error = await replay(read(file), BEHIND_A_HOLDER);
        if (error) failures.push(`${file}: ${error.code} ${error.message}`);
      }
      return failures;
    });

    expect(failed).toEqual([]);
  });

  it("fails behind a writer with 001's index guard taken out, and only then", async () => {
    const before = unguarded(EXTENSIONS_AND_TRIGGERS, INDEX_GUARD);

    const error = await whileHolding(await standIn({ vacuum: false }), () =>
      replay(before, BEHIND_A_HOLDER),
    );
    // 55P03 is lock_not_available: the replay waited on the writer, and it is
    // the writer that `db/migrate.ts` reports as the reason.
    expect(error?.code).toBe('55P03');

    // Once the writer has committed the same text runs, so what failed was the
    // wait, not the edit.
    expect(await replay(before, UNHELD)).toBeNull();
  });

  it("fails behind a vacuum of jobs with 005's options guard taken out, and only then", async () => {
    const before = unguarded(STORAGE_PARAMETERS, OPTIONS_GUARD);

    const error = await whileHolding(JOBS_VACUUMED, () => replay(before, BEHIND_A_HOLDER));
    expect(error?.code).toBe('55P03');

    expect(await replay(before, UNHELD)).toBeNull();
  });
});

describe('a replay of db/sql with something to do', { timeout: 60_000 }, () => {
  const INDEX = 'kb_articles_title_trgm_idx';
  const DEFINED = `CREATE INDEX ${INDEX} ON public.kb_articles USING gin (title gin_trgm_ops)`;

  const definition = async () => {
    const [row] = await replayer<{ definition: string | null }[]>`
      select pg_get_indexdef(to_regclass(${`public.${INDEX}`})) as definition`;
    return row!.definition;
  };

  /** The index as 001 defines it again, whatever a case left behind. */
  async function restoreIndex(): Promise<void> {
    expect(await replay(`DROP INDEX IF EXISTS public.${INDEX}`, UNHELD)).toBeNull();
    expect(await replay(EXTENSIONS_AND_TRIGGERS, UNHELD)).toBeNull();
    expect(await definition()).toBe(DEFINED);
  }

  it('builds an index 001 names that is missing, as it was defined', async () => {
    expect(await definition()).toBe(DEFINED);

    try {
      expect(await replay(`DROP INDEX public.${INDEX}`, UNHELD)).toBeNull();
      expect(await definition()).toBeNull();

      expect(await replay(EXTENSIONS_AND_TRIGGERS, UNHELD)).toBeNull();
      expect(await definition()).toBe(DEFINED);
    } finally {
      await restoreIndex();
    }
  });

  it('refuses an index under that name that is not the one 001 defines', async () => {
    try {
      // An entry edited to another column, met on a database that has the old
      // index, would look like this.
      expect(await replay(`DROP INDEX public.${INDEX}`, UNHELD)).toBeNull();
      expect(
        await replay(
          `CREATE INDEX ${INDEX} ON public.kb_articles USING gin (slug gin_trgm_ops)`,
          UNHELD,
        ),
      ).toBeNull();

      const error = await replay(EXTENSIONS_AND_TRIGGERS, UNHELD);
      expect(error?.message).toBe(
        `public.${INDEX} is not the index db/sql/001 defines: a valid gin (title gin_trgm_ops) on public.kb_articles`,
      );
    } finally {
      await restoreIndex();
    }
  });

  it('refuses the index it defines when it is INVALID', async () => {
    try {
      // The state a failed `CREATE INDEX CONCURRENTLY` leaves. Written into the
      // catalog because a concurrent build cannot be made to fail on cue, and
      // this flag is all the guard reads of it.
      expect(
        await replay(
          `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'public.${INDEX}'::regclass`,
          UNHELD,
        ),
      ).toBeNull();

      const error = await replay(EXTENSIONS_AND_TRIGGERS, UNHELD);
      expect(error?.message).toMatch(new RegExp(`^public\\.${INDEX} is not the index`));
    } finally {
      await restoreIndex();
    }
  });

  it("sets 005's options on jobs when one differs or none is set, and keeps one set by hand", async () => {
    const options = async () => {
      const [row] = await replayer<{ options: string[] | null }[]>`
        select reloptions as options from pg_class where oid = 'public.jobs'::regclass`;
      return [...(row!.options ?? [])].sort();
    };
    const tuned = [
      'autovacuum_analyze_scale_factor=0.02',
      'autovacuum_analyze_threshold=200',
      'autovacuum_vacuum_scale_factor=0.02',
      'autovacuum_vacuum_threshold=200',
    ];
    expect(await options()).toEqual(tuned);

    try {
      expect(
        await replay(
          'ALTER TABLE public.jobs SET (autovacuum_vacuum_threshold = 500, fillfactor = 90)',
          UNHELD,
        ),
      ).toBeNull();
      expect(await replay(STORAGE_PARAMETERS, UNHELD)).toBeNull();
      expect(await options()).toEqual([...tuned, 'fillfactor=90'].sort());

      expect(
        await replay(
          'ALTER TABLE public.jobs RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, ' +
            'autovacuum_analyze_scale_factor, autovacuum_analyze_threshold, fillfactor)',
          UNHELD,
        ),
      ).toBeNull();
      expect(await options()).toEqual([]);
      expect(await replay(STORAGE_PARAMETERS, UNHELD)).toBeNull();
      expect(await options()).toEqual(tuned);
    } finally {
      expect(await replay('ALTER TABLE public.jobs RESET (fillfactor)', UNHELD)).toBeNull();
      expect(await replay(STORAGE_PARAMETERS, UNHELD)).toBeNull();
    }
  });
});
