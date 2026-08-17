-- Post-migration SQL: things Drizzle's schema DSL cannot express.
--
-- Every statement here MUST be idempotent. db/migrate.ts re-runs this file after
-- every drizzle migration, so it doubles as the place to keep database-level
-- behaviour in sync without hand-editing generated migrations.

-- --------------------------------------------------------------------------
-- Extensions
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- --------------------------------------------------------------------------
-- Fuzzy search
--
-- The tsvector columns use the 'simple' config because Postgres has no Arabic
-- text-search configuration. That gives exact-token matching but no tolerance
-- for typos or partial words, so these trigram indexes sit alongside them and
-- carry substring/fuzzy queries for both languages.
--
-- Query these with word_similarity (`'query' <% column`) or ILIKE, NOT with the
-- plain similarity operator `%`. `%` compares whole strings, so a short search
-- term against a long subject scores below the 0.3 threshold and matches
-- nothing. Both `<%` and ILIKE are index-accelerated by gin_trgm_ops; verified
-- against Postgres 16.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS conversations_subject_trgm_idx
  ON conversations USING gin (subject gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contacts_name_trgm_idx
  ON contacts USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contacts_email_trgm_idx
  ON contacts USING gin (primary_email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS companies_name_trgm_idx
  ON companies USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS kb_articles_title_trgm_idx
  ON kb_articles USING gin (title gin_trgm_ops);

-- --------------------------------------------------------------------------
-- Deferred foreign key
--
-- groups.business_hours_id is declared without a reference in the Drizzle schema
-- because config.ts and agents.ts would otherwise import each other.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'groups_business_hours_id_fk'
  ) THEN
    ALTER TABLE groups
      ADD CONSTRAINT groups_business_hours_id_fk
      FOREIGN KEY (business_hours_id) REFERENCES business_hours(id) ON DELETE SET NULL;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- updated_at maintenance
--
-- Applied by looping over every table that has an updated_at column, so new
-- tables pick this up automatically on the next migrate run.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public'
      AND c.column_name = 'updated_at'
      AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t);
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Realtime fan-out
--
-- Each web instance holds one session-mode LISTEN connection. NOTIFY broadcasts
-- to every listener, so this works unchanged across autoscaled instances with no
-- Redis or external pub/sub.
--
-- The payload is deliberately tiny — ids only, never message bodies. NOTIFY has
-- an 8000-byte limit, and clients re-fetch the actual rows through the normal
-- authorised query path so the stream can never leak a ticket to an agent who
-- is not allowed to see it.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_conversation_change() RETURNS trigger AS $$
DECLARE
  conversation_id uuid;
  payload text;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    conversation_id := NEW.conversation_id;
  ELSE
    conversation_id := NEW.id;
  END IF;

  payload := json_build_object(
    'table', TG_TABLE_NAME,
    'op', lower(TG_OP),
    'conversationId', conversation_id,
    'rowId', NEW.id,
    'at', extract(epoch from now())
  )::text;

  PERFORM pg_notify('conversation_changed', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notify_change ON messages;
CREATE TRIGGER notify_change
  AFTER INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_conversation_change();

DROP TRIGGER IF EXISTS notify_change ON conversations;
CREATE TRIGGER notify_change
  AFTER INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_conversation_change();

-- --------------------------------------------------------------------------
-- Job queue wake-up
--
-- Lets the worker block on LISTEN instead of polling every second, so a reply
-- an agent sends goes out immediately rather than up to a poll interval later.
-- The worker still polls on a timer as a backstop for scheduled (run_at) jobs.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_job_enqueued() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' AND NEW.run_at <= now() THEN
    PERFORM pg_notify('job_enqueued', NEW.type);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notify_enqueued ON jobs;
CREATE TRIGGER notify_enqueued
  AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION notify_job_enqueued();
