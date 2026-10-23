-- ===========================================================================
-- Rolling back Stage 2.B of plans/ticket-category-routing.md, by hand
--
-- Not a migration and never replayed: nothing reads this directory but its
-- test. Drizzle applies only migrations newer than the newest row in
-- drizzle.__drizzle_migrations, and 0046 cannot be deleted from main once it
-- has shipped, so a reverse migration in the repository is not a way back. This
-- is. It puts every name 0046 and db/sql/002_subcategories.sql moved back to
-- what production had before them, read from production on 2026-10-23:
--
--   - the two enum types, the four tables and their three renamed columns;
--   - the seven foreign keys and the composite primary key Drizzle re-added
--     under new names, renamed back rather than dropped and re-added, so no
--     row is validated again and no lock outlives the transaction;
--   - the thirteen explicit indexes;
--   - the six CHECK constraints and the three primary keys Postgres named.
--
-- Then it deletes 0046's row from drizzle.__drizzle_migrations, so that a later
-- deploy of main applies 0046 again. Rows are untouched: a rename moves no data.
--
-- One DO block, so it is one statement and one transaction however it is run:
-- a name that is not there raises, and nothing is left half renamed. Run it on
-- the session connection, never the transaction pooler, with the worker and
-- crons suspended (the plan's rollback, step 2):
--
--   psql "$DATABASE_URL_SESSION" -v ON_ERROR_STOP=1 -f db/runbooks/2b-subcategory-rollback.sql
--
-- Then deploy the previous web commit by hand: its preDeploy replays the old
-- db/sql/002_categories.sql, which finds its own names again and does nothing.
-- 2b-subcategory-rollback.db.test.ts runs this file and then 0046 and
-- db/sql/002 again inside a transaction it rolls back, so the way back and the
-- way forward are exercised on every CI run.
--
-- It stops being a way back once Stage 3 has created the new
-- `ticket_categories`, because the names collide. That stage deletes it.
-- ===========================================================================

DO $$
DECLARE
  removed integer;
BEGIN
  -- The tables are small and the worker is suspended, but web is serving: a
  -- lock this cannot get within 3 s is somebody else's open transaction, and
  -- failing names it faster than waiting does.
  PERFORM set_config('lock_timeout', '3s', true);

  ALTER TYPE subcategory_audience RENAME TO category_audience;
  ALTER TYPE subcategory_review_state RENAME TO category_review_state;

  ALTER TABLE ticket_subcategories RENAME TO ticket_categories;
  ALTER TABLE conversation_subcategories RENAME TO conversation_categories;
  ALTER TABLE subcategory_metrics_daily RENAME TO category_metrics_daily;
  ALTER TABLE ai_subcategory_runs RENAME TO ai_category_runs;

  ALTER TABLE conversation_categories RENAME COLUMN subcategory_id TO category_id;
  ALTER TABLE conversation_categories RENAME COLUMN subcategory_key TO category_key;
  ALTER TABLE category_metrics_daily RENAME COLUMN subcategory_key TO category_key;

  -- Renaming a constraint that owns an index renames the index too, which is
  -- what the composite primary key and the three `_pkey` names rely on. Two of
  -- the names Drizzle gave in 0046 are longer than the 63 bytes Postgres keeps,
  -- so they are written here as the catalog stores them, ending `_f` and `_`;
  -- production already holds eight foreign keys cut short the same way.
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_conversation_id_subcategory_id_pk
    TO conversation_categories_conversation_id_category_id_pk;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_conversation_id_conversations_id_fk
    TO conversation_categories_conversation_id_conversations_id_fk;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_subcategory_id_ticket_subcategories_
    TO conversation_categories_category_id_ticket_categories_id_fk;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_detected_in_message_id_messages_id_f
    TO conversation_categories_detected_in_message_id_messages_id_fk;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_assigned_by_agent_id_agents_id_fk
    TO conversation_categories_assigned_by_agent_id_agents_id_fk;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_reviewed_by_agent_id_agents_id_fk
    TO conversation_categories_reviewed_by_agent_id_agents_id_fk;
  ALTER TABLE ai_category_runs
    RENAME CONSTRAINT ai_subcategory_runs_conversation_id_conversations_id_fk
    TO ai_category_runs_conversation_id_conversations_id_fk;
  ALTER TABLE ai_category_runs
    RENAME CONSTRAINT ai_subcategory_runs_message_id_messages_id_fk
    TO ai_category_runs_message_id_messages_id_fk;

  ALTER INDEX ticket_subcategories_key_idx RENAME TO ticket_categories_key_idx;
  ALTER INDEX ticket_subcategories_area_idx RENAME TO ticket_categories_area_idx;
  ALTER INDEX ticket_subcategories_active_idx RENAME TO ticket_categories_active_idx;
  ALTER INDEX conversation_subcategories_primary_idx RENAME TO conversation_categories_primary_idx;
  ALTER INDEX conversation_subcategories_key_idx RENAME TO conversation_categories_key_idx;
  ALTER INDEX conversation_subcategories_subcategory_idx RENAME TO conversation_categories_category_idx;
  ALTER INDEX conversation_subcategories_review_idx RENAME TO conversation_categories_review_idx;
  ALTER INDEX subcategory_metrics_daily_dimensions_idx RENAME TO category_metrics_daily_dimensions_idx;
  ALTER INDEX subcategory_metrics_daily_day_idx RENAME TO category_metrics_daily_day_idx;
  ALTER INDEX subcategory_metrics_daily_area_idx RENAME TO category_metrics_daily_area_idx;
  ALTER INDEX ai_subcategory_runs_label_message_idx RENAME TO ai_category_runs_label_message_idx;
  ALTER INDEX ai_subcategory_runs_label_idx RENAME TO ai_category_runs_label_idx;
  ALTER INDEX ai_subcategory_runs_conversation_idx RENAME TO ai_category_runs_conversation_idx;

  ALTER TABLE ticket_categories
    RENAME CONSTRAINT ticket_subcategories_key_shape TO ticket_categories_key_shape;
  ALTER TABLE ticket_categories
    RENAME CONSTRAINT ticket_subcategories_area_matches_key TO ticket_categories_area_matches_key;
  ALTER TABLE ticket_categories
    RENAME CONSTRAINT ticket_subcategories_no_self_merge TO ticket_categories_no_self_merge;
  ALTER TABLE ticket_categories
    RENAME CONSTRAINT ticket_subcategories_pkey TO ticket_categories_pkey;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_confidence_range
    TO conversation_categories_confidence_range;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_manual_is_certain
    TO conversation_categories_manual_is_certain;
  ALTER TABLE conversation_categories
    RENAME CONSTRAINT conversation_subcategories_rejected_not_primary
    TO conversation_categories_rejected_not_primary;
  ALTER TABLE category_metrics_daily
    RENAME CONSTRAINT subcategory_metrics_daily_pkey TO category_metrics_daily_pkey;
  ALTER TABLE ai_category_runs
    RENAME CONSTRAINT ai_subcategory_runs_pkey TO ai_category_runs_pkey;

  -- 0046_subcategory_names, by the `when` its journal entry carries, which is
  -- what Drizzle stores as `created_at`. Exactly one row, or the database is not
  -- the one this was written for and nothing above is kept.
  DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792781241219;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION 'expected one drizzle.__drizzle_migrations row for 0046_subcategory_names, found %', removed;
  END IF;
END $$;
