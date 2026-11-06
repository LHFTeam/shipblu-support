-- Post-migration SQL: things Drizzle's schema DSL cannot express.
--
-- Every statement here MUST be idempotent. db/migrate.ts re-runs this file after
-- every drizzle migration, so it doubles as the place to keep database-level
-- behaviour in sync without hand-editing generated migrations.
--
-- And once it has nothing to do, it must take no lock on a table stronger than
-- the ones reads and writes take (ROW EXCLUSIVE), since anything stronger waits
-- on somebody's open transaction. The file runs as one transaction, so a lock
-- it is granted is held until its last statement commits. A statement that
-- needs a stronger lock is guarded by a catalog lookup and runs only when there
-- is something to change. `db/sql/replay-locks.db.test.ts` holds every file in
-- `db/sql` to that.

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
--
-- Each index is looked for before it is created, because `CREATE INDEX IF NOT
-- EXISTS` alone is not a no-op on a replay: it takes SHARE on its table before
-- it finds the index already there (PROJECT-STATE §6.110). Every open writer
-- of that table holds SHARE off, so the replay waited on each of them, and the
-- SHARE it was granted held that table's writes off until this whole file
-- committed, because the file runs as one transaction. The guard asks the
-- catalog, which takes no lock on the table, so a replay that finds the index
-- touches nothing. It asks the question `IF NOT EXISTS` asks, whether any
-- relation of that name is in the schema, only before the lock rather than
-- after it. A missing index is still built as before, under SHARE on its table
-- until the file commits.
--
-- `IF NOT EXISTS` stays inside the statement the guard runs. The `db-sql` repo
-- rule refuses a CREATE INDEX without it, string or not. It also skips an index
-- another replay committed after this one's guard looked. It does not make two
-- replays whose transactions overlap safe. Neither sees the other's uncommitted
-- index, and SHARE does not conflict with SHARE, so both build it. The second
-- then fails on the catalog's unique name (23505) once the first commits, or on
-- the lock timeout. It failed the same way before the guard, and nothing here
-- relies on it: only the web service's preDeploy runs `db:migrate`.
--
-- Each index is named once, in the list below, and the guard and the statement
-- are both built from that one name, so the two cannot ask about different
-- indexes. A guard asking for a name the statement never creates would build
-- nothing and read as success. A statement creating a name the guard never asks
-- for would take its lock on every replay again.
--
-- A name is not a definition, so an index found under its name is also checked
-- against its entry: a valid gin `gin_trgm_ops` index on that table's one
-- column. Anything else fails the replay. `IF NOT EXISTS` alone skipped it in
-- silence. That would leave an entry edited to another column changing nothing
-- on a database that has the old index, and an index left INVALID by a failed
-- `CREATE INDEX CONCURRENTLY` skipped on every replay, with the search it
-- serves unindexed. Neither can be repaired here: rebuilding an index in this
-- file holds its table's writes for the whole build. So the error says how to
-- rebuild it by hand, and the deploy waits until somebody has. The check reads
-- only the catalog, so it locks nothing either. A fresh database never meets
-- it, since every index there is built from its entry.
--
-- `db/sql/replay-locks.db.test.ts` replays every file behind a writer and a
-- vacuum on every relation in the schema. It then replays this one with the
-- guard taken out, to show that the writer is what the guard avoids.
--
-- Do NOT reach for CREATE INDEX CONCURRENTLY here. db/migrate.ts sends each file
-- as one sql.unsafe(contents), which wraps it in an implicit transaction, and
-- CONCURRENTLY cannot run inside one. The shipments indexes were built on tables
-- that were empty at first deploy, so the blocking build cost nothing; an index
-- on a table the size of `messages` needs its own migration, not this file.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  wanted record;
  existing oid;
BEGIN
  FOR wanted IN
    SELECT * FROM (VALUES
      ('conversations_subject_trgm_idx', 'conversations', 'subject'),
      ('contacts_name_trgm_idx', 'contacts', 'name'),
      ('contacts_email_trgm_idx', 'contacts', 'primary_email'),

      -- The inbox search reaches these two as well. Phone is how a WhatsApp
      -- customer is looked up at all, since most of them have no email. Message
      -- text is the only place a chat's actual content lives, because the
      -- messaging channels give every ticket a subject picked from a short list
      -- of canned categories.
      ('contacts_phone_trgm_idx', 'contacts', 'primary_phone'),
      ('messages_body_trgm_idx', 'messages', 'body_text'),

      -- The hub's answer is searchable for the same reason a message body is:
      -- it is where "driver attempted twice, phone off" is written down, and
      -- that sentence is what an agent half-remembers three weeks later. Agents
      -- only ever see this table, so there is no visibility question to answer.
      ('side_conversation_messages_body_trgm_idx', 'side_conversation_messages', 'body_text'),

      ('companies_name_trgm_idx', 'companies', 'name'),
      ('kb_articles_title_trgm_idx', 'kb_articles', 'title'),

      -- Shipments and shipping accounts. The unique btree on each canonical
      -- value carries every exact lookup: the sidebar, the shipment page,
      -- `track:` search, and the future platform endpoint. These carry the other
      -- half, the partial number an agent types from memory ("...8154?"), which
      -- a btree cannot serve.
      ('shipments_tracking_trgm_idx', 'shipments', 'tracking_number'),
      ('shipping_accounts_sbid_trgm_idx', 'shipping_accounts', 'sbid'),
      ('shipping_accounts_name_trgm_idx', 'shipping_accounts', 'name')
    ) AS trigram (index_name, table_name, column_name)
  LOOP
    existing := to_regclass(format('public.%I', wanted.index_name));

    IF existing IS NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I USING gin (%I gin_trgm_ops)',
        wanted.index_name, wanted.table_name, wanted.column_name
      );
    ELSIF NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am ON am.oid = ic.relam
      JOIN pg_opclass opc ON opc.oid = i.indclass[0]
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indexrelid = existing
        AND i.indrelid = to_regclass(format('public.%I', wanted.table_name))
        AND i.indnatts = 1
        AND a.attname = wanted.column_name
        AND am.amname = 'gin'
        AND opc.opcname = 'gin_trgm_ops'
        AND i.indexprs IS NULL
        AND i.indpred IS NULL
        AND i.indisvalid
    ) THEN
      RAISE EXCEPTION 'public.% is not the index db/sql/001 defines: a valid gin (% gin_trgm_ops) on public.%',
          wanted.index_name, wanted.column_name, wanted.table_name
        USING HINT = 'This file builds a missing index and never rebuilds one, because that '
          'would hold the table''s writes for the whole build. Rebuild it by hand, outside '
          'a transaction: drop it with DROP INDEX CONCURRENTLY, and build it again '
          'concurrently with the definition in the message. Then deploy again '
          '(PROJECT-STATE §6.110).';
    END IF;
  END LOOP;
END $$;

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
-- that do not already have it — in the steady state this loop takes no locks at
-- all. That is the rule for every statement in this file. The trigram indexes at
-- its top meet it the same way, by asking the catalog first (§6.110).
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
--
-- On every table but one this stamps `now()` on any UPDATE at all, values
-- changed or not, and an UPDATE cannot set the column itself: whatever it
-- writes there is replaced by its own transaction's `now()`, so no writer can
-- backdate it. `presence_policy` depends on exactly that: its grace period is
-- anchored on `updated_at` (`StoredPresencePolicy` in `lib/presence/idle.ts`).
--
-- The one is `kb_articles`, because readers write to it. `recordArticleView`
-- adds one to `view_count` on every article view, and the feedback endpoint
-- adds one to `helpful_count` or `unhelpful_count` on every tap, so with the
-- plain stamp the column was the date somebody last read the article, and the
-- console's article list, which shows it and sorts by it, ordered articles by
-- their readers (PROJECT-STATE §6.51). There an UPDATE that changes nothing
-- but those three counters keeps the date it had, and any other change stamps
-- `now()` as everywhere else. An UPDATE that changes nothing at all keeps the
-- date too: it is no edit either, and the date it would stamp is the noise
-- §6.59 records. The column is still the trigger's: a value an UPDATE writes
-- into it is replaced either way, by the old date or by `now()`.
--
-- The comparison is the whole row minus a deny-list rather than a list of the
-- columns that count as an edit, so a column added to the table later counts
-- by default — a new counter has to be named here, and leaving one out costs
-- a date that moves too often, never one that misses an edit. `updated_at` is
-- left out because it is what is being decided. `search_vector` is left out
-- because it is a stored generated column, and Postgres computes those after
-- the BEFORE triggers have run: inside this function `NEW.search_vector` is
-- null while `OLD.search_vector` holds the old value, so leaving it in would
-- make every row look changed. It is derived from the title and the body,
-- which are compared on their own.
--
-- Here, in the one shared function, rather than in a trigger of its own on
-- `kb_articles`, because of the locks. Changing which function the table's
-- trigger calls is trigger DDL: `DROP TRIGGER` takes ACCESS EXCLUSIVE, which
-- any open reader holds off (the loop below says what that cost on
-- 2026-08-19), and `CREATE OR REPLACE TRIGGER` takes SHARE ROW EXCLUSIVE,
-- which any open writer holds off — every view and every vote is one — and
-- which then holds every write to the table off until this whole file
-- commits, because the file runs as one transaction. A trigger of another
-- name would also have the loop create the generic one again beside it, still
-- stamping. `CREATE OR REPLACE FUNCTION` locks no table at all, and every
-- replay installs the current body, so the change reaches a running database
-- on the next deploy with nothing to guard. Undoing it is the same statement
-- with the old body.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- The columns a reader writes, and the two that are not part of what an
  -- edit compares. See the comment above for why each is here.
  not_an_edit constant text[] := ARRAY[
    'updated_at', 'search_vector', 'view_count', 'helpful_count', 'unhelpful_count'
  ];
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'kb_articles' THEN
    IF (to_jsonb(NEW) - not_an_edit) = (to_jsonb(OLD) - not_an_edit) THEN
      NEW.updated_at = OLD.updated_at;
      RETURN NEW;
    END IF;
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Only tables that do not already have the trigger.
--
-- This file is replayed on every deploy, and trigger DDL locks the table:
-- `DROP TRIGGER` takes ACCESS EXCLUSIVE, and `CREATE TRIGGER` SHARE ROW
-- EXCLUSIVE, which waits on any open writer. Dropping and recreating an
-- identical trigger every time therefore asked for an exclusive lock on every
-- busy table in the schema to do nothing, and any concurrent *reader* was
-- enough to make it wait: on 2026-08-19 two connections left mid-transaction on
-- `agents` held AccessShareLock for six hours and every deploy in between
-- failed on `DROP TRIGGER IF EXISTS touch_updated_at ON agents`.
--
-- Checking first makes this loop lock-free in the steady state: a table that
-- already has the trigger is skipped without touching it. New tables still pick it up, which is
-- what the loop is for.
--
-- The trade: changing the trigger's *definition* — its timing, its events, the
-- function it calls — is no longer picked up by a replay, because only its
-- presence is checked. What it does is not part of that definition: the body of
-- `touch_updated_at()` above is installed by `CREATE OR REPLACE FUNCTION` on
-- every replay, which locks no table, so a change of behaviour belongs there,
-- as the `kb_articles` case does. A trigger that really must change is
-- replaced in place with `CREATE OR REPLACE TRIGGER` under the same name —
-- SHARE ROW EXCLUSIVE, never the DROP's ACCESS EXCLUSIVE — under a guard that
-- compares what it is (`tgfoid`, its events), not its name, and under a
-- `lock_timeout` set for the transaction alone, the way
-- `008_comment_channel_check.sql` sets one before its guarded constraint. Giving
-- the new one a different name is not a way round this: this loop would create
-- the generic trigger again beside it.
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
        -- Who answers for the ticket decides who may see it (`answerableBy`),
        -- so a handover that moves only this must refresh the queues as a
        -- reassignment does: the new owner's list gains the ticket.
        OLD.accountable_agent_id IS DISTINCT FROM NEW.accountable_agent_id OR
        OLD.group_id IS DISTINCT FROM NEW.group_id OR
        -- The inbox filters on the category and draws it on every row, so a
        -- change to it alone must redraw the queues as a group move does.
        OLD.category_id IS DISTINCT FROM NEW.category_id OR
        OLD.tags IS DISTINCT FROM NEW.tags OR
        OLD.last_message_at IS DISTINCT FROM NEW.last_message_at OR
        OLD.last_customer_message_at IS DISTINCT FROM NEW.last_customer_message_at OR
        OLD.merged_into_id IS DISTINCT FROM NEW.merged_into_id OR
        OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR
        -- The inbox's "Routing…" badge is drawn from the routing hold's two
        -- columns. Only the insert writes the window, so this is for symmetry.
        OLD.routing_window_ends_at IS DISTINCT FROM NEW.routing_window_ends_at OR
        -- The hold ending is often the only change: a decision that moved
        -- nothing and assigned nobody touches no other column listed here.
        OLD.routing_decided_at IS DISTINCT FROM NEW.routing_decided_at;
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
