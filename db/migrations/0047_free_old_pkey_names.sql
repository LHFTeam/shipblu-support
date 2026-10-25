-- Hand-written (`drizzle-kit generate --custom`), and the one migration here
-- that is: it changes nothing the snapshot records, so its snapshot is 0046's
-- and CI's drift step regenerates nothing for it.
--
-- Stage 2.B renamed the subcategory tables in 0046, but the three primary keys
-- Postgres named itself (`<table>_pkey`) are renamed only by
-- db/sql/002_subcategories.sql, which runs after every migration. On a fresh
-- database — CI, `shipblu_test`, a staging that takes 2.B and Stage 3 in one
-- deploy — `ticket_categories_pkey` is therefore still taken when 0048 creates
-- the new `ticket_categories`, whose unnamed primary key would be created as
-- `ticket_categories_pkey1` there and `ticket_categories_pkey` in production.
-- Renamed here, ahead of it, both databases name it the same.
--
-- Guarded on the constraint's name and its table, as 002 is: production renamed
-- all three when 2.B deployed, so there this does nothing. Renaming a primary
-- key constraint renames its index with it.
DO $$
DECLARE
  renamed record;
BEGIN
  FOR renamed IN
    SELECT * FROM (VALUES
      ('ticket_subcategories', 'ticket_categories_pkey', 'ticket_subcategories_pkey'),
      ('subcategory_metrics_daily', 'category_metrics_daily_pkey', 'subcategory_metrics_daily_pkey'),
      ('ai_subcategory_runs', 'ai_category_runs_pkey', 'ai_subcategory_runs_pkey')
    ) AS r (relation, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = renamed.old_name
        AND conrelid = to_regclass('public.' || renamed.relation)
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        renamed.relation, renamed.old_name, renamed.new_name
      );
    END IF;
  END LOOP;
END $$;
