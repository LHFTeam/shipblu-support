import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * What a replay of `db/sql` locks once it has nothing left to do, which is
 * what every deploy's `npm run db:migrate` does after the first.
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
 * So the rule: in the steady state no file takes a table lock stronger than
 * ROW EXCLUSIVE, the lock every INSERT, UPDATE and DELETE takes. Reads, writes
 * and vacuums never hold one off, and nothing a deploy is likely to meet can
 * hold off one of them. The first case checks every file, and its failure names
 * the file, the table and the mode. The others replay a file behind a session
 * standing in for what it used to wait on, as the deploy would meet it. Then
 * they take the file's guard out and show the same replay failing, so the
 * stand-in is known to be one the guard avoids, and not one nothing waits on.
 * Last, the guards still do their job when there is something to do.
 *
 * The stand-ins take their lock with `LOCK TABLE`, in the mode a writer or a
 * vacuum holds until it ends, because a table lock conflicts by mode alone.
 * Rows in the table and the statement holding the lock make no difference.
 */

withCleanDatabase();

const DIR = new URL('./', import.meta.url);
const FILES = readdirSync(DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const read = (file: string) => readFileSync(new URL(file, DIR), 'utf8');

const EXTENSIONS_AND_TRIGGERS = read('001_extensions_and_triggers.sql');
const STORAGE_PARAMETERS = read('005_storage_parameters.sql');

/** Short, as in the measurement in §6.110: a wait this long is a wait on the holder. */
const LOCK_TIMEOUT = '1s';

/** Each file's guard, as the file spells it. A test fails if one is reworded. */
const INDEX_GUARD = "IF to_regclass(format('public.%I', wanted.index_name)) IS NULL THEN";
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

/**
 * A file as `db/migrate.ts` sends it: one simple query, so one implicit
 * transaction, on a session whose `lock_timeout` is set. Answers the error,
 * or null.
 */
async function replay(text: string): Promise<{ code?: string } | null> {
  await replayer.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
  return replayer.unsafe(text).then(
    () => null,
    (error: unknown) => error as { code?: string },
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

/** An open writer on every table in the schema, which is every table any file indexes. */
async function everyTableWritten(): Promise<string> {
  const tables = await holder<{ name: string }[]>`
    select format('%I.%I', schemaname, tablename) as name
    from pg_tables where schemaname = 'public'`;
  return `LOCK TABLE ${tables.map((t) => t.name).join(', ')} IN ROW EXCLUSIVE MODE`;
}

/** What a vacuum or an analyze of `jobs` holds, and a `REINDEX CONCURRENTLY` of it. */
const JOBS_VACUUMED = 'LOCK TABLE public.jobs IN SHARE UPDATE EXCLUSIVE MODE';

describe('a replay of db/sql with nothing to do', () => {
  it('takes no table lock stronger than a write takes, in any file', async () => {
    const taken: string[] = [];

    for (const file of FILES) {
      // Committed, as `db/migrate.ts` commits it. The locks are read inside the
      // transaction, before the commit releases them.
      const locks = await replayer.begin(async (tx) => {
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

  it('runs 001 through behind an open writer on every table it indexes', async () => {
    const error = await whileHolding(await everyTableWritten(), () =>
      replay(EXTENSIONS_AND_TRIGGERS),
    );

    expect(error).toBeNull();
  });

  it("fails behind the same writer with 001's index guard taken out, and only then", async () => {
    const before = unguarded(EXTENSIONS_AND_TRIGGERS, INDEX_GUARD);

    const error = await whileHolding(await everyTableWritten(), () => replay(before));
    // 55P03 is lock_not_available: the replay waited on the writer, and it is
    // the writer that `db/migrate.ts` reports as the reason.
    expect(error?.code).toBe('55P03');

    // Once the writer has committed the same text runs, so what failed was the
    // wait, not the edit.
    expect(await replay(before)).toBeNull();
  });

  it('runs 005 through behind a vacuum of jobs, and fails behind it with the guard taken out', async () => {
    expect(await whileHolding(JOBS_VACUUMED, () => replay(STORAGE_PARAMETERS))).toBeNull();

    const before = unguarded(STORAGE_PARAMETERS, OPTIONS_GUARD);
    const error = await whileHolding(JOBS_VACUUMED, () => replay(before));
    expect(error?.code).toBe('55P03');
  });
});

describe('a replay of db/sql with something to do', () => {
  it('builds an index 001 names that is missing, as it was defined', async () => {
    const definition = async () => {
      const [row] = await replayer<{ definition: string | null }[]>`
        select pg_get_indexdef(to_regclass('public.kb_articles_title_trgm_idx')) as definition`;
      return row!.definition;
    };
    const original = await definition();
    expect(original).toBe(
      'CREATE INDEX kb_articles_title_trgm_idx ON public.kb_articles USING gin (title gin_trgm_ops)',
    );

    try {
      await replayer.unsafe('DROP INDEX public.kb_articles_title_trgm_idx');
      expect(await definition()).toBeNull();

      expect(await replay(EXTENSIONS_AND_TRIGGERS)).toBeNull();
      expect(await definition()).toBe(original);
    } finally {
      // A no-op once the index is back, so a failure above leaves no later
      // file without it.
      await replay(EXTENSIONS_AND_TRIGGERS);
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
      await replayer.unsafe(
        'ALTER TABLE public.jobs SET (autovacuum_vacuum_threshold = 500, fillfactor = 90)',
      );
      expect(await replay(STORAGE_PARAMETERS)).toBeNull();
      expect(await options()).toEqual([...tuned, 'fillfactor=90'].sort());

      await replayer.unsafe(
        'ALTER TABLE public.jobs RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, ' +
          'autovacuum_analyze_scale_factor, autovacuum_analyze_threshold, fillfactor)',
      );
      expect(await options()).toEqual([]);
      expect(await replay(STORAGE_PARAMETERS)).toBeNull();
      expect(await options()).toEqual(tuned);
    } finally {
      await replayer.unsafe('ALTER TABLE public.jobs RESET (fillfactor)');
      await replay(STORAGE_PARAMETERS);
    }
  });
});
