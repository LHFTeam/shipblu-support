-- Hand-written (`drizzle-kit generate --custom`), as 0047 is: it changes
-- nothing the snapshot records, so its snapshot is 0058's and CI's drift step
-- regenerates nothing for it.
--
-- The copy of the knowledge base's reader counters from `kb_articles` into
-- `kb_article_stats`, ahead of 0060, which drops them (plans/kb-article-stats.md).
-- It used to be db/sql/011_kb_article_stats_backfill.sql, which replays after
-- every migration. That order cannot serve a database taking 0057 and 0060 in
-- one deploy: staging, suspended since before 0057, or any database that skipped
-- the release carrying it. There the columns would be gone before db/sql ran,
-- and every count with them. Here the copy runs between the two, inside the one
-- transaction the migrations share.
--
-- In production it inserts nothing. Every count was copied when 0057 deployed,
-- and nothing has written the old columns since. `ON CONFLICT (article_id) DO
-- NOTHING` leaves a stats row as it is, whoever wrote it, and an article whose
-- counters are all zero has nothing to copy. It reads `kb_articles` under ACCESS
-- SHARE, which 0060's ACCESS EXCLUSIVE in the same transaction then supersedes.
--
-- Guarded on the three columns, as AGENTS.md asks of a hand-written migration
-- and as 0047 is on its constraints, so the copy never reads a column that is
-- not there: PL/pgSQL plans the INSERT only when it runs. That makes 0059 safe
-- on its own, run by hand or in a test. It does not let a database without
-- the columns migrate. Drizzle runs 0060 in the same transaction whenever 0059
-- is pending, and 0060's DROP COLUMN fails there with 42703, taking every
-- pending migration with it. Such a database, its drop run by hand or its
-- migration rows reset after 0060, needs the columns back first, as
-- db/runbooks/kb-article-counters-restore.sql adds them.
DO $$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kb_articles'
      AND column_name IN ('view_count', 'helpful_count', 'unhelpful_count')
  ) = 3 THEN
    INSERT INTO kb_article_stats (article_id, view_count, helpful_count, unhelpful_count)
    SELECT id, view_count, helpful_count, unhelpful_count
    FROM kb_articles
    WHERE view_count <> 0 OR helpful_count <> 0 OR unhelpful_count <> 0
    ON CONFLICT (article_id) DO NOTHING;
  END IF;
END $$;
