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

-- The inbox search reaches these two as well. Phone is how a WhatsApp customer
-- is looked up at all — most of them have no email — and message text is the
-- only place a chat's actual content lives, because the messaging channels give
-- every ticket a subject picked from a short list of canned categories.
CREATE INDEX IF NOT EXISTS contacts_phone_trgm_idx
  ON contacts USING gin (primary_phone gin_trgm_ops);

CREATE INDEX IF NOT EXISTS messages_body_trgm_idx
  ON messages USING gin (body_text gin_trgm_ops);

-- The hub's answer is searchable for the same reason a message body is: it is
-- where "driver attempted twice, phone off" is written down, and that sentence
-- is what an agent half-remembers three weeks later. Agents only ever see this
-- table, so there is no visibility question to answer here.
CREATE INDEX IF NOT EXISTS side_conversation_messages_body_trgm_idx
  ON side_conversation_messages USING gin (body_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS companies_name_trgm_idx
  ON companies USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS kb_articles_title_trgm_idx
  ON kb_articles USING gin (title gin_trgm_ops);

-- Shipments and shipping accounts. The unique btree on each canonical value
-- carries every exact lookup — the sidebar, the shipment page, `track:` search,
-- and the future platform endpoint. These carry the other half: the partial
-- number an agent types from memory ("...8154?"), which a btree cannot serve.
--
-- Do NOT reach for CREATE INDEX CONCURRENTLY here. db/migrate.ts sends each file
-- as one sql.unsafe(contents), which wraps it in an implicit transaction, and
-- CONCURRENTLY cannot run inside one. These three build on tables that are empty
-- at first deploy so the blocking build costs nothing; an index on a table the
-- size of `messages` needs its own migration, not this file.
CREATE INDEX IF NOT EXISTS shipments_tracking_trgm_idx
  ON shipments USING gin (tracking_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS shipping_accounts_sbid_trgm_idx
  ON shipping_accounts USING gin (sbid gin_trgm_ops);

CREATE INDEX IF NOT EXISTS shipping_accounts_name_trgm_idx
  ON shipping_accounts USING gin (name gin_trgm_ops);

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
-- Attachments belong to exactly one message
--
-- `attachments` carries files from ticket messages and from side conversation
-- messages, with a nullable owner column for each. Two things Drizzle's DSL
-- cannot say are said here.
--
-- The foreign key is deferred to SQL because db/schema/side-conversations.ts
-- imports conversations.ts; declaring the column against that table in Drizzle
-- would make the two modules circular. Same reason as groups.business_hours_id
-- above.
--
-- The CHECK is the one that matters. Without it "both null" is a legal row: an
-- orphan no query returns, no cascade deletes, and whose file sits in the bucket
-- for ever. "Both set" is worse — the attachment route would authorise against
-- whichever join it happened to try first.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attachments_side_message_id_fk'
  ) THEN
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_side_message_id_fk
      FOREIGN KEY (side_message_id) REFERENCES side_conversation_messages(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attachments_one_owner'
  ) THEN
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_one_owner
      CHECK ((message_id IS NULL) <> (side_message_id IS NULL));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- A side conversation names at most one directory entry
--
-- The picker reads two registers and keeps them apart. `locations` is the places
-- ShipBlu works out of; `internal_recipients` is the parties that are not places — Finance, a courier
-- partner. A thread points at one or the other, or at neither when the agent
-- typed an address by hand.
--
-- Both set is the state worth forbidding: the card's title, the sidebar entry and
-- the reply box would each name whichever join their query reached first, so the
-- same thread would appear to be addressed to two different people on two parts
-- of one screen.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'side_conversations_one_directory'
  ) THEN
    ALTER TABLE side_conversations
      ADD CONSTRAINT side_conversations_one_directory
      CHECK (location_id IS NULL OR recipient_id IS NULL);
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Row level security
--
-- RLS enabled, zero policies, never FORCE. The app connects as `postgres`, the
-- table owner, which bypasses RLS entirely — so an enabled-but-policy-less table
-- is fully readable by the app and completely closed to everyone else. It is a
-- lockdown against direct PostgREST access, not an app-level authorisation
-- mechanism; authorisation lives in code. Adding FORCE would break every query
-- in the app.
--
-- A loop over `public` rather than a list of table names, because Drizzle does
-- not emit ENABLE ROW LEVEL SECURITY and nothing in this repo ever asked for it:
-- the enabled state on the original tables was set by hand, outside the
-- migrations, so a fresh `npm run db:migrate` against an empty Postgres produces
-- every table with RLS *off*. Each table added since has drifted the same way.
-- Seven reached production open — the five from the shipment work plus
-- `contact_sessions` and `contact_tokens` from the customer portal — and since
-- Supabase grants `anon` and `authenticated` full DML on everything in `public`
-- by default, all seven were readable *and writable* with the anon key that
-- ships in client bundles.
--
-- This replaces a named three-table block added alongside the side conversations
-- schema, whose own comment said the loop was the better answer and a strict
-- superset of it. It is: `internal_recipients`, `side_conversations` and
-- `side_conversation_messages` are covered here, and the last of those is the
-- worst table in this schema to leave open — it is the internal discussion
-- *about* a customer, which is the one thing that feature exists to keep away
-- from them.
--
-- A list has the same gap one table later. The loop means the next table is
-- locked down by the next deploy whether or not anybody remembered.
--
-- Enabling RLS takes ACCESS EXCLUSIVE on the table, so this only touches tables
-- that do not already have it — the steady state takes no locks at all, which is
-- the rule the rest of this file follows.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    RAISE NOTICE 'enabled row level security on %', t;
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- updated_at maintenance
--
-- Applied by looping over every table that has an updated_at column, so new
-- tables pick this up automatically on the next migrate run.
-- --------------------------------------------------------------------------
-- SET search_path = '' on every function below.
--
-- Without it the search_path is whatever the calling role has set, so anyone who
-- can create objects in an earlier schema could shadow a function or operator
-- these bodies rely on and have it run with the definer's reach. Everything
-- referenced here lives in pg_catalog, which is always searched implicitly, so
-- pinning the path costs nothing.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Only tables that do not already have the trigger.
--
-- This file is replayed on every deploy, and trigger DDL — DROP or CREATE alike
-- — needs ACCESS EXCLUSIVE on the table. Dropping and recreating an identical
-- trigger every time therefore asked for an exclusive lock on every busy table
-- in the schema to do nothing, and any concurrent *reader* was enough to make
-- it wait: on 2026-08-19 two connections left mid-transaction on `agents` held
-- AccessShareLock for six hours and every deploy in between failed on
-- `DROP TRIGGER IF EXISTS touch_updated_at ON agents`.
--
-- Checking first makes the steady state lock-free: a table that already has the
-- trigger is skipped without touching it. New tables still pick it up, which is
-- what the loop is for.
--
-- The trade: changing the trigger's *definition* is no longer picked up by a
-- replay, because only its presence is checked. Drop it explicitly (or give the
-- new one a different name) when that day comes.
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
      AND NOT EXISTS (
        SELECT 1
        FROM pg_trigger tg
        JOIN pg_class cl ON cl.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = c.table_schema
          AND cl.relname = c.table_name
          AND tg.tgname = 'touch_updated_at'
          AND NOT tg.tgisinternal
      )
  LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t);
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Realtime fan-out
--
-- LISTEN/NOTIFY works across autoscaled instances without Redis, but a single
-- global topic turns every write into work for every open browser. Queue topics
-- are therefore split by channel, and ticket/widget topics by conversation id.
-- A customer-bot receipt cannot reach the working inbox, and one widget cannot
-- make every other widget re-read its transcript.
--
-- The payload is deliberately tiny — ids only, never message bodies. NOTIFY has
-- an 8000-byte limit, and clients re-fetch the actual rows through the normal
-- authorised query path so the stream can never leak a ticket to an agent who
-- is not allowed to see it.
--
-- There is deliberately no global topic. `conversation_changed` used to fire
-- here on every trigger invocation, kept for one zero-downtime deploy window so
-- that instances still serving the previous client bundle kept working. That
-- window closed weeks and roughly ten deploys ago, and nothing has listened to
-- the name since the §6.23 fan-out work replaced it with the per-channel and
-- per-conversation topics above. It was removed on 2026-09-09 rather than left
-- as a NOTIFY nobody receives on every message insert and every conversation
-- update.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_conversation_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  conversation_id uuid;
  conversation_channel text;
  previous_channel text;
  queue_relevant boolean := false;
  payload text;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    conversation_id := NEW.conversation_id;
  ELSIF TG_TABLE_NAME = 'side_conversation_messages' THEN
    -- One hop further out: a side conversation message names its thread, and the
    -- thread names the ticket. Schema-qualified because this function runs with
    -- SET search_path = '' and would otherwise not find the table at all.
    SELECT sc.conversation_id INTO conversation_id
    FROM public.side_conversations sc
    WHERE sc.id = NEW.side_conversation_id;
  ELSIF TG_TABLE_NAME = 'side_conversations' THEN
    conversation_id := NEW.conversation_id;
  ELSE
    conversation_id := NEW.id;
  END IF;

  IF TG_TABLE_NAME = 'conversations' THEN
    conversation_channel := NEW.channel::text;
    IF TG_OP = 'UPDATE' THEN
      previous_channel := OLD.channel::text;
    END IF;
  ELSE
    SELECT c.channel::text INTO conversation_channel
    FROM public.conversations c
    WHERE c.id = conversation_id;
  END IF;

  -- A cascading delete can remove the parent before a child notification has a
  -- channel to route to. There is no useful subscriber in that case.
  IF conversation_id IS NULL OR conversation_channel IS NULL THEN
    RETURN NULL;
  END IF;

  payload := json_build_object(
    'table', TG_TABLE_NAME,
    'op', lower(TG_OP),
    'conversationId', conversation_id,
    'channel', conversation_channel,
    'rowId', NEW.id,
    'at', extract(epoch from now())
  )::text;

  -- The ticket view and widget listen only to this UUID-derived identifier.
  -- Removing hyphens keeps the topic a simple, bounded PostgreSQL identifier.
  PERFORM pg_notify(
    'conversation_' || replace(conversation_id::text, '-', ''),
    payload
  );

  -- Only changes that can alter the list, its filters or its counts reach a
  -- queue topic. Message delivery updates still reach the open ticket above,
  -- but no longer re-run the working queue.
  IF TG_TABLE_NAME = 'messages' THEN
    queue_relevant := TG_OP = 'INSERT';
  ELSIF TG_TABLE_NAME = 'side_conversation_messages' THEN
    queue_relevant := TG_OP = 'INSERT';
  ELSIF TG_TABLE_NAME = 'side_conversations' THEN
    IF TG_OP = 'UPDATE' THEN
      queue_relevant := OLD.state IS DISTINCT FROM NEW.state;
    END IF;
  ELSIF TG_TABLE_NAME = 'conversations' THEN
    IF TG_OP = 'INSERT' THEN
      queue_relevant := true;
    ELSE
      queue_relevant :=
        OLD.subject IS DISTINCT FROM NEW.subject OR
        OLD.channel IS DISTINCT FROM NEW.channel OR
        OLD.status_id IS DISTINCT FROM NEW.status_id OR
        OLD.priority IS DISTINCT FROM NEW.priority OR
        OLD.requester_contact_id IS DISTINCT FROM NEW.requester_contact_id OR
        OLD.assignee_agent_id IS DISTINCT FROM NEW.assignee_agent_id OR
        OLD.group_id IS DISTINCT FROM NEW.group_id OR
        OLD.tags IS DISTINCT FROM NEW.tags OR
        OLD.last_message_at IS DISTINCT FROM NEW.last_message_at OR
        OLD.last_customer_message_at IS DISTINCT FROM NEW.last_customer_message_at OR
        OLD.merged_into_id IS DISTINCT FROM NEW.merged_into_id OR
        OLD.deleted_at IS DISTINCT FROM NEW.deleted_at;
    END IF;
  END IF;

  IF queue_relevant THEN
    PERFORM pg_notify('conversation_queue_' || conversation_channel, payload);

    -- Channel changes are rare, but both lists must update: one loses the row
    -- and the other gains it. Treating the channel as immutable here would make
    -- a future correction leave a stale ticket behind until the next event.
    IF previous_channel IS NOT NULL AND previous_channel <> conversation_channel THEN
      PERFORM pg_notify('conversation_queue_' || previous_channel, payload);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- Guarded rather than dropped and recreated, for the lock reason above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relname = 'messages'
      AND tg.tgname = 'notify_change' AND NOT tg.tgisinternal
  ) THEN
    CREATE TRIGGER notify_change
      AFTER INSERT OR UPDATE ON messages
      FOR EACH ROW EXECUTE FUNCTION notify_conversation_change();
  END IF;
END $$;

-- Guarded rather than dropped and recreated, for the lock reason above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relname = 'conversations'
      AND tg.tgname = 'notify_change' AND NOT tg.tgisinternal
  ) THEN
    CREATE TRIGGER notify_change
      AFTER INSERT OR UPDATE ON conversations
      FOR EACH ROW EXECUTE FUNCTION notify_conversation_change();
  END IF;
END $$;

-- The hub answering is the moment an agent has been waiting for, so it reaches
-- the open ticket the same way a customer's reply does. Guarded rather than
-- dropped and recreated, for the lock reason above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relname = 'side_conversation_messages'
      AND tg.tgname = 'notify_change' AND NOT tg.tgisinternal
  ) THEN
    CREATE TRIGGER notify_change
      AFTER INSERT OR UPDATE ON side_conversation_messages
      FOR EACH ROW EXECUTE FUNCTION notify_conversation_change();
  END IF;
END $$;

-- A thread being marked done changes the inbox's waiting/replied badge, and its
-- metadata is part of the open ticket. Message inserts already notify through
-- their own trigger; this one covers the thread row itself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relname = 'side_conversations'
      AND tg.tgname = 'notify_change' AND NOT tg.tgisinternal
  ) THEN
    CREATE TRIGGER notify_change
      AFTER INSERT OR UPDATE ON side_conversations
      FOR EACH ROW EXECUTE FUNCTION notify_conversation_change();
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Job queue wake-up
--
-- Lets the worker block on LISTEN instead of polling every second, so a reply
-- an agent sends goes out immediately rather than up to a poll interval later.
-- The worker still polls on a timer as a backstop for scheduled (run_at) jobs.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_job_enqueued() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'pending' AND NEW.run_at <= now() THEN
    PERFORM pg_notify('job_enqueued', NEW.type);
  END IF;
  RETURN NULL;
END;
$$;

-- Guarded rather than dropped and recreated, for the lock reason above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relname = 'jobs'
      AND tg.tgname = 'notify_enqueued' AND NOT tg.tgisinternal
  ) THEN
    CREATE TRIGGER notify_enqueued
      AFTER INSERT ON jobs
      FOR EACH ROW EXECUTE FUNCTION notify_job_enqueued();
  END IF;
END $$;
