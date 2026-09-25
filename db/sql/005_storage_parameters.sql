-- Per-table storage parameters: autovacuum tuned for one table that churns.
--
-- Every statement here MUST be idempotent, like the rest of db/sql. These are
-- naturally so — `ALTER TABLE ... SET (...)` assigns a value rather than adding
-- an object, so a replay writes the same number again and takes no lock worth
-- naming (it is a catalogue update, not a rewrite).
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
ALTER TABLE jobs SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 200,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 200
);
