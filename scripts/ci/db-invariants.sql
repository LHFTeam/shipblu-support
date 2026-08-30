-- Invariants that only a real database can answer, asserted after
-- `npm run db:migrate` has run against an empty Postgres.
--
-- These are the two row level security rules from AGENTS.md, and neither can be
-- checked by reading the repo. Whether a table ends up with RLS enabled is the
-- result of running the loop in db/sql over whatever tables the migrations
-- actually created — a grep can tell you the loop is still there, not that it
-- covered the table added this morning.
--
-- Run with `psql -v ON_ERROR_STOP=1`, so a RAISE EXCEPTION fails the job.

-- --------------------------------------------------------------------------
-- Every table in `public` has row level security enabled.
--
-- RLS is enabled with zero policies, and the app connects as the table owner,
-- which bypasses it: enabled-but-policy-less means fully readable by the app and
-- completely closed to everything else. It is a lockdown against direct
-- PostgREST access, and it matters because Supabase grants `anon` and
-- `authenticated` full DML on everything in `public` by default.
--
-- Seven tables reached production without it — the five from the shipment work
-- plus contact_sessions and contact_tokens — and were readable *and writable*
-- with the anon key that ships in client bundles. Drizzle does not emit ENABLE
-- ROW LEVEL SECURITY, so a table added to db/schema/ arrives switched off and
-- stays that way until the loop in db/sql runs. This asserts the loop covered
-- everything the migrations just created.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  open_tables text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO open_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relrowsecurity;

  IF open_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'row level security is off on: %. Supabase grants anon and authenticated full DML on public by default, so these are readable and writable with the anon key that ships in client bundles. The loop in db/sql should have covered them.',
      open_tables;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- No table FORCEs row level security.
--
-- The app connects as the table owner and relies on the owner's bypass. FORCE
-- removes it, and every query in the system starts returning nothing — the one
-- rule in AGENTS.md whose blast radius is the whole product.
--
-- Checked here as well as by grep because FORCE can also arrive from outside the
-- repo: a migration applied by hand, or somebody clicking it in a dashboard.
-- This asserts the state the repo actually produces.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  forced text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relforcerowsecurity;

  IF forced IS NOT NULL THEN
    RAISE EXCEPTION
      'FORCE row level security is set on: %. The app connects as the table owner, so this breaks every query in the system.',
      forced;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- The migrations actually built a schema.
--
-- A guard against the assertions above passing vacuously: "zero tables without
-- RLS" is also true of a database where nothing was created, which is what a
-- silently half-applied migration run looks like.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  tables int;
  names text;
BEGIN
  SELECT count(*), string_agg(c.relname, ' ' ORDER BY c.relname)
  INTO tables, names
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';

  IF tables < 30 THEN
    RAISE EXCEPTION 'only % tables in public — the migrations did not fully apply', tables;
  END IF;

  -- The names, not only the count. A count that is one higher than the schema
  -- defines is the kind of silent difference AGENTS.md asks to be broken down
  -- along the dimension that can fail: it says something was created that the
  -- migrations did not create, and only the list says what.
  RAISE NOTICE 'ok: % tables, all with RLS enabled and none forcing it', tables;
  RAISE NOTICE 'covered: %', names;
END $$;
