-- Per-table storage parameters: autovacuum tuned for one table that churns.
--
-- Every statement here MUST be idempotent, like the rest of db/sql, and must
-- take no lock once there is nothing to change (001's header says why). An
-- `ALTER TABLE ... SET (...)` is idempotent on its own, since it assigns a
-- value rather than adding an object. It still is not free on a replay. It
-- takes SHARE UPDATE EXCLUSIVE on the table every time, and rewrites the
-- table's catalog row with the same values. That lock is the one VACUUM holds.
-- A deploy that landed during an autovacuum of `jobs`, the very table this
-- file tunes autovacuum for, cancelled it after `deadlock_timeout`. Or, if it
-- was a wraparound vacuum, which is never cancelled, the deploy waited on it.
-- The replay also waited on any `REINDEX ... CONCURRENTLY` of the table, which
-- is the reclaim recommended below (PROJECT-STATE §6.110). So the
-- options are compared with what `pg_class.reloptions` already holds first,
-- which takes no lock, and set only when one of them differs.
--
-- Why only `jobs`. On 2026-09-09 it held **1,150 live rows in 52 MB**, 30 MB of
-- that in indexes, with `jobs_dedupe_idx` alone at 15 MB — the one table the
-- Supabase advisor flags as bloated. The cause is its shape rather than a bug:
-- roughly 200,000 rows are inserted and then deleted every seven weeks, so the
-- heap and its indexes grow to the high-water mark of a burst and stay there.
--
-- Be clear about what this does and does not fix. Lowering the scale factors
-- makes autovacuum run on a fraction of the churn rather than a fifth of a
-- table that is almost always tiny, which keeps free space recycled and slows
-- index bloat from here on. It does **not** give the 30 MB back: vacuum marks
-- space reusable, it does not shrink the files. Reclaiming what is already
-- there needs
--
--   REINDEX INDEX CONCURRENTLY jobs_dedupe_idx;
--
-- which cannot live in this file at all — db/migrate.ts sends each file as one
-- `sql.unsafe(contents)`, so the whole thing runs in one implicit transaction
-- and CONCURRENTLY is rejected inside one. Run it by hand, and check §5.5's
-- `pg_stat_activity` query for a conflicting lock first: this is the table the
-- worker claims from every second.

-- The defaults are 0.2 / 0.1 of the live row count, plus a threshold of 50.
-- Against 1,150 live rows that is ~280 dead tuples before a vacuum, which a
-- single batch of webhook jobs passes in seconds — so the table spends its life
-- either just-vacuumed or far past due, depending on the burst. The fixed
-- thresholds below decide it on absolute churn instead, which is the thing that
-- is actually large here.
--
-- Each option is written once, as `name=value` text in the form Postgres stores
-- it in `reloptions`. That is the parsed value, not the text as typed. A
-- number keeps its spelling (`0.02` stays `0.02`, `.02` stays `.02`). A quoted
-- value loses its quotes, a keyword is lowercased (`TRUE` is stored as
-- `true`), and a unary `+` is dropped. So write each entry as an unquoted
-- lowercase word or an unsigned number. Written any other way, the ALTER still
-- sets it, but the comparison never matches, the ALTER runs on every replay,
-- and the first case of `db/sql/replay-locks.db.test.ts` names the lock that
-- brings back.
--
-- Both the comparison and the ALTER are built from that one list, so changing
-- a value here cannot leave the guard comparing against the old one. A guard
-- written out separately would find the old value still stored and never
-- apply the new one. Options set on `jobs` by hand, and not named here, are
-- left alone, as the plain SET left them.
DO $$
DECLARE
  wanted constant text[] := ARRAY[
    'autovacuum_vacuum_scale_factor=0.02',
    'autovacuum_vacuum_threshold=200',
    'autovacuum_analyze_scale_factor=0.02',
    'autovacuum_analyze_threshold=200'
  ];
BEGIN
  IF NOT coalesce(
    (SELECT reloptions @> wanted FROM pg_class WHERE oid = 'public.jobs'::regclass),
    false
  ) THEN
    EXECUTE format('ALTER TABLE public.jobs SET (%s)', array_to_string(wanted, ', '));
  END IF;
END $$;
