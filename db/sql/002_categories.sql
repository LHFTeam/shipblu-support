-- ===========================================================================
-- Ticket categorisation: the invariants Drizzle's DSL cannot express
--
-- Everything here is a CHECK constraint. The tables, columns and indexes are in
-- db/schema/ and db/migrations/ where they belong — including both partial
-- indexes, which drizzle-orm can express with .where() and therefore must.
--
-- No RLS statements: the loop over `public` in 001 covers new tables, and
-- maintaining a list beside it is what let seven tables reach production
-- readable with the anon key.
--
-- Replayed after every migration, so every statement is guarded.
-- ===========================================================================

DO $$
BEGIN
  -- -------------------------------------------------------------------------
  -- A category key is `area.slug`, and `area` says the same thing
  --
  -- The `area` column is denormalised out of the key so a report can group by it
  -- without split_part in every query. Denormalised data with nothing holding it
  -- in step is data that will disagree, and the disagreement would show up as a
  -- category quietly missing from an area's chart rather than as an error.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_key_shape'
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_key_shape
      CHECK (key ~ '^[a-z]+\.[a-z_]+$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_area_matches_key'
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_area_matches_key
      CHECK (area = split_part(key, '.', 1));
  END IF;

  -- -------------------------------------------------------------------------
  -- A merge pointer never points at itself
  --
  -- `superseded_by_key` is how a category is merged without rewriting the
  -- assignments that already name it. The resolver follows one hop and does not
  -- recurse, so a self-reference would be an infinite loop in a report query if
  -- it ever did.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_no_self_merge'
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_no_self_merge
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
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_root_causes_key_shape'
  ) THEN
    ALTER TABLE ticket_root_causes
      ADD CONSTRAINT ticket_root_causes_key_shape
      CHECK (key ~ '^[a-z]+\.[a-z_]+$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_root_causes_owner_matches_key'
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
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_categories_confidence_range'
  ) THEN
    ALTER TABLE conversation_categories
      ADD CONSTRAINT conversation_categories_confidence_range
      CHECK (confidence >= 0 AND confidence <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_categories_manual_is_certain'
  ) THEN
    ALTER TABLE conversation_categories
      ADD CONSTRAINT conversation_categories_manual_is_certain
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
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_categories_rejected_not_primary'
  ) THEN
    ALTER TABLE conversation_categories
      ADD CONSTRAINT conversation_categories_rejected_not_primary
      CHECK (review_state <> 'rejected' OR NOT is_primary);
  END IF;

  -- -------------------------------------------------------------------------
  -- The stored key matches the category it points at
  --
  -- `category_key` is frozen at assignment time so a report run next year reads
  -- what was actually assigned rather than what the registry has since been
  -- renamed to. That is only sound if it started out correct; a CHECK cannot
  -- join, so this is enforced in lib/categorise/apply.ts, and this comment is
  -- here so the next person looking for the constraint finds out why there
  -- isn't one.
  -- -------------------------------------------------------------------------
END $$;
