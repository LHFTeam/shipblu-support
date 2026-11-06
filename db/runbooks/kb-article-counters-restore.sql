-- ===========================================================================
-- The way back from the second half of plans/kb-article-stats.md, by hand
--
-- Not a migration and never replayed: nothing reads this directory but its
-- test. Migration 0060 dropped `view_count`, `helpful_count` and
-- `unhelpful_count` from `kb_articles`. The build before it, the plan's first
-- half, cannot run without them. Every INSERT it makes into the table names all
-- three, because Drizzle names every column, and its preDeploy replays
-- db/sql/011, which reads them. A reverse migration in the repository is not a
-- way back either: that build cannot carry it. This is.
--
-- It puts the three back as they were before 0060, `integer NOT NULL DEFAULT
-- 0`. Then it deletes 0060's row from drizzle.__drizzle_migrations, so that a
-- later deploy of a build carrying 0060 drops them again rather than skipping
-- it. That holds only while 0060 is the newest migration applied, because
-- Drizzle applies only migrations newer than the newest row, and it refuses
-- otherwise. Nothing is copied back. The counts live in `kb_article_stats`,
-- which the first half's code reads and counts into. The columns come back only
-- for its INSERTs, and its replay of 011 finds each one zero and copies
-- nothing.
--
-- One DO block, so it is one statement and one transaction however it is run.
-- Run it on the session connection, never the transaction pooler:
--
--   psql "$DATABASE_URL_SESSION" -v ON_ERROR_STOP=1 -f db/runbooks/kb-article-counters-restore.sql
--
-- Then put the web service back on the build it ran before this release, by
-- hand. Not by reverting the release: a revert deletes 0059 and 0060, and CI
-- refuses a pull request that deletes a migration (`generated-files`). Even
-- forced through, the work landing again later would carry 0060 under a `when`
-- older than whatever was generated in between, and Drizzle would never apply
-- it.
--
--   1. Turn auto-deploy off on every production service that has it on. Read
--      each one's setting in the dashboard, since render.yaml and
--      docs/PROJECT-STATE.md §2 can lag it; on 2026-11-06 all six had it on.
--      All six, not the web service alone. Otherwise a commit on `main` still
--      carrying 0060 drops the columns again under the old build. Only the web
--      service migrates, so a worker or cron going live on newer code would
--      also meet a schema nothing has migrated.
--   2. Deploy the earlier build to the web service. The worker and the crons
--      can stay on the second half's code, which names none of the three and
--      runs with them there as without.
--
-- Rolling forward again is turning auto-deploy back on. The next deploy of
-- `main` applies 0060 again, since its row is gone and it is newer than every
-- row left.
--
-- It is also the way out of a deploy whose preDeploy failed after 0060
-- committed, or whose new release never went live. The first half's web
-- release keeps serving there, and fails only on creating an article until
-- this commits. Deploying the same commit again is the other way out of that
-- state: its migrate finds 0060 applied and only replays db/sql.
--
-- kb-article-counters-restore.db.test.ts runs this file and then 0060 again
-- inside a transaction it rolls back, so the way back and the way forward are
-- exercised on every CI run. It stops being a way back once any migration
-- after 0060 has been applied, and the PR that adds that migration deletes
-- this file and its test, which then fails and says so.
-- ===========================================================================

DO $$
DECLARE
  removed integer;
BEGIN
  -- Web is serving, so a lock this cannot get within 3 s is somebody else's
  -- open transaction, and failing names it faster than waiting does. Adding a
  -- column with a constant default writes no row: it is a catalog change under
  -- ACCESS EXCLUSIVE, held until this block commits, and every read of the
  -- table queues behind it while it waits.
  PERFORM set_config('lock_timeout', '3s', true);

  -- Deleting 0060's row makes Drizzle apply it again only while 0060 is the
  -- newest migration applied: Drizzle compares each migration with the newest
  -- row's `created_at`, not with the rows that are missing. Once a later
  -- migration has run, this is no longer a way back, and it says so before it
  -- changes anything.
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1793998971121) THEN
    RAISE EXCEPTION 'a migration newer than 0060_kb_articles_drop_counters has been applied, so deleting its row would not make the next deploy apply it again: this runbook is no longer the way back';
  END IF;

  -- On a database where the columns are already back, a second run, this
  -- raises and keeps nothing.
  ALTER TABLE kb_articles
    ADD COLUMN view_count integer NOT NULL DEFAULT 0,
    ADD COLUMN helpful_count integer NOT NULL DEFAULT 0,
    ADD COLUMN unhelpful_count integer NOT NULL DEFAULT 0;

  -- 0060_kb_articles_drop_counters, by the `when` its journal entry carries,
  -- which is what Drizzle stores as `created_at`. Exactly one row, or the
  -- database is not the one this was written for and nothing above is kept.
  DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793998971121;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION 'expected one drizzle.__drizzle_migrations row for 0060_kb_articles_drop_counters, found %', removed;
  END IF;
END $$;
