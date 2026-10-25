-- ===========================================================================
-- Ticket subcategorisation: the invariants Drizzle's DSL cannot express
--
-- Everything here is a CHECK constraint. The tables, columns and indexes are
-- in db/schema/ and db/migrations/ where they belong — including both partial
-- indexes, which drizzle-orm can express with .where() and therefore must.
--
-- No RLS statements: the loop over `public` in 001 covers new tables, and
-- maintaining a list beside it is what let seven tables reach production
-- readable with the anon key.
--
-- Replayed after every migration, so every statement is guarded.
-- ===========================================================================

DO $$
DECLARE
  renamed record;
BEGIN
  -- -------------------------------------------------------------------------
  -- The names Stage 2.B of plans/ticket-category-routing.md moved
  --
  -- Until 2.B these tables were `ticket_categories`, `conversation_categories`,
  -- `category_metrics_daily` and `ai_category_runs`, and this file was
  -- 002_categories.sql. Migration 0046 renames the tables, but `ALTER TABLE …
  -- RENAME` leaves the names of their CHECK constraints, which Drizzle cannot
  -- see, so they are renamed here: on a database that had them (production) in
  -- place, and on a fresh one too, since every migration runs before this file
  -- and 0046 has renamed tables created under the old names by then.
  --
  -- The three primary keys Postgres named itself (`<table>_pkey`) were renamed
  -- here too until Stage 3, which moved them into migration 0047: Stage 3's own
  -- `ticket_categories` is created by a migration, and on a fresh database the
  -- old `ticket_categories_pkey` was still taken then, so its key would have
  -- been named `_pkey1` there and `_pkey` in production. Production had renamed
  -- all three here already, so nothing there changed.
  --
  -- Each lookup names the table as well as the constraint. Stage 3 creates a
  -- new `ticket_categories` for the category field, and a guard on the name
  -- alone would one day find that table's constraints and rename or skip the
  -- wrong thing. `to_regclass` is null for a table that does not exist, which
  -- matches no row, rather than an error.
  -- -------------------------------------------------------------------------
  FOR renamed IN
    SELECT * FROM (VALUES
      ('ticket_subcategories', 'ticket_categories_key_shape', 'ticket_subcategories_key_shape'),
      ('ticket_subcategories', 'ticket_categories_area_matches_key', 'ticket_subcategories_area_matches_key'),
      ('ticket_subcategories', 'ticket_categories_no_self_merge', 'ticket_subcategories_no_self_merge'),
      ('conversation_subcategories', 'conversation_categories_confidence_range', 'conversation_subcategories_confidence_range'),
      ('conversation_subcategories', 'conversation_categories_manual_is_certain', 'conversation_subcategories_manual_is_certain'),
      ('conversation_subcategories', 'conversation_categories_rejected_not_primary', 'conversation_subcategories_rejected_not_primary')
    ) AS r (relation, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = renamed.old_name
        AND conrelid = to_regclass('public.' || renamed.relation)
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = renamed.new_name
        AND conrelid = to_regclass('public.' || renamed.relation)
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        renamed.relation, renamed.old_name, renamed.new_name
      );
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- A subcategory key is `area.slug`, and `area` says the same thing
  --
  -- The `area` column is denormalised out of the key so a report can group by it
  -- without split_part in every query. Denormalised data with nothing holding it
  -- in step is data that will disagree, and the disagreement would show up as a
  -- subcategory quietly missing from an area's chart rather than as an error.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_subcategories_key_shape'
      AND conrelid = 'public.ticket_subcategories'::regclass
  ) THEN
    ALTER TABLE ticket_subcategories
      ADD CONSTRAINT ticket_subcategories_key_shape
      CHECK (key ~ '^[a-z]+\.[a-z_]+$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_subcategories_area_matches_key'
      AND conrelid = 'public.ticket_subcategories'::regclass
  ) THEN
    ALTER TABLE ticket_subcategories
      ADD CONSTRAINT ticket_subcategories_area_matches_key
      CHECK (area = split_part(key, '.', 1));
  END IF;

  -- -------------------------------------------------------------------------
  -- A merge pointer never points at itself
  --
  -- `superseded_by_key` is how a subcategory is merged without rewriting the
  -- assignments that already name it. The resolver follows one hop and does not
  -- recurse, so a self-reference would be an infinite loop in a report query if
  -- it ever did.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_subcategories_no_self_merge'
      AND conrelid = 'public.ticket_subcategories'::regclass
  ) THEN
    ALTER TABLE ticket_subcategories
      ADD CONSTRAINT ticket_subcategories_no_self_merge
      CHECK (superseded_by_key IS NULL OR superseded_by_key <> key);
  END IF;

  -- -------------------------------------------------------------------------
  -- A root cause key names its own owner
  --
  -- The prefix IS the owner, so `courier.no_attempt` cannot be filed under `hub`
  -- by a typo in an admin form. Without this the owner column and the key can
  -- disagree, and every accountability report is drawn from the column.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_root_causes_key_shape'
      AND conrelid = 'public.ticket_root_causes'::regclass
  ) THEN
    ALTER TABLE ticket_root_causes
      ADD CONSTRAINT ticket_root_causes_key_shape
      CHECK (key ~ '^[a-z]+\.[a-z_]+$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_root_causes_owner_matches_key'
      AND conrelid = 'public.ticket_root_causes'::regclass
  ) THEN
    ALTER TABLE ticket_root_causes
      ADD CONSTRAINT ticket_root_causes_owner_matches_key
      CHECK (split_part(key, '.', 1) = owner::text);
  END IF;

  -- -------------------------------------------------------------------------
  -- Confidence is a grade between 0 and 1, and a person's choice is not a guess
  --
  -- `manual` means an agent chose it. Storing anything but 1 there would let a
  -- threshold sweep — "re-open everything below 0.9 for review" — reopen a
  -- question a human has already answered, which is the one thing the review
  -- queue must never do.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_subcategories_confidence_range'
      AND conrelid = 'public.conversation_subcategories'::regclass
  ) THEN
    ALTER TABLE conversation_subcategories
      ADD CONSTRAINT conversation_subcategories_confidence_range
      CHECK (confidence >= 0 AND confidence <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_subcategories_manual_is_certain'
      AND conrelid = 'public.conversation_subcategories'::regclass
  ) THEN
    ALTER TABLE conversation_subcategories
      ADD CONSTRAINT conversation_subcategories_manual_is_certain
      CHECK (source <> 'manual' OR confidence = 1);
  END IF;

  -- -------------------------------------------------------------------------
  -- A rejected assignment is never the primary
  --
  -- A rejected row is kept rather than deleted, because it is what stops the
  -- next detector run re-suggesting the same thing and it is the only record of
  -- what a rule got wrong. Keeping it means it is still a row a query could pick
  -- up, so the one thing it must never be is the answer a report reads.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_subcategories_rejected_not_primary'
      AND conrelid = 'public.conversation_subcategories'::regclass
  ) THEN
    ALTER TABLE conversation_subcategories
      ADD CONSTRAINT conversation_subcategories_rejected_not_primary
      CHECK (review_state <> 'rejected' OR NOT is_primary);
  END IF;

  -- -------------------------------------------------------------------------
  -- The stored key matches the subcategory it points at
  --
  -- `subcategory_key` is frozen at assignment time so a report run next year
  -- reads what was actually assigned rather than what the registry has since
  -- been renamed to. That is only sound if it started out correct; a CHECK
  -- cannot join, so this is enforced in lib/subcategorise/apply.ts, and this
  -- comment is here so the next person looking for the constraint finds out why
  -- there isn't one.
  -- -------------------------------------------------------------------------
END $$;
