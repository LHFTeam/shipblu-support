-- Post-migration SQL: every agent gets a tile colour, once.
--
-- `agents.avatar_color` (migration 0029) is what tells two agents with the same
-- initials apart in the inbox, and it is only worth anything if it never moves:
-- an agent who has learned "mine are the violet ones" must not come in one
-- morning to find them amber. So it is assigned exactly once, when the row is
-- created, and nothing here or in the app ever reassigns it.
--
-- **A trigger rather than a line in each insert.** Agents are created by the
-- first-admin setup and by accepting an invite today, and by the seed and every
-- test fixture besides; a colour each of them had to remember to pick is a
-- colour the next one forgets. `BEFORE INSERT` covers all of them, and it only
-- fills a NULL, so a caller that does choose a colour keeps it.
--
-- **Least used, ties in palette order.** With fewer agents than colours nobody
-- shares; past that, the colours fill evenly instead of the lottery a hash gives
-- (eleven agents hashed onto these nine came out 3/3/3/1/1). Two agents created
-- at the same instant can land on the same colour — the count each reads does
-- not include the other — which costs one repeat, not a wrong answer.
--
-- **The palette is spelled out twice**, here and as `AGENT_COLORS` in
-- lib/auth/agent-colors.ts, because the trigger has to choose without the app
-- and the app has to render without the database. `agent_avatar_palette()` is
-- a function so `lib/auth/agent-colors.db.test.ts` can read it back and fail CI
-- when the two lists differ. Append new colours at the end: the order is what
-- the next agent gets, and existing agents keep what they hold regardless.

CREATE OR REPLACE FUNCTION agent_avatar_palette() RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['blue', 'emerald', 'violet', 'amber', 'pink', 'cyan', 'lime', 'fuchsia', 'slate']
$$;

CREATE OR REPLACE FUNCTION next_agent_avatar_color() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT palette.color
  FROM unnest(agent_avatar_palette()) WITH ORDINALITY AS palette(color, position)
  LEFT JOIN agents ON agents.avatar_color = palette.color
  GROUP BY palette.color, palette.position
  ORDER BY count(agents.id), palette.position
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION assign_agent_avatar_color() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.avatar_color IS NULL THEN
    NEW.avatar_color := next_agent_avatar_color();
  END IF;
  RETURN NEW;
END;
$$;

-- Guarded rather than dropped and recreated: this file replays on every deploy,
-- and `DROP TRIGGER` takes a lock on `agents`, which every signed-in request
-- reads (001_extensions_and_triggers.sql gives the same reason at length).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relname = 'agents'
      AND tg.tgname = 'assign_avatar_color' AND NOT tg.tgisinternal
  ) THEN
    CREATE TRIGGER assign_avatar_color
      BEFORE INSERT ON agents
      FOR EACH ROW EXECUTE FUNCTION assign_agent_avatar_color();
  END IF;
END;
$$;

-- The agents that existed before the column did, in the order they joined, one
-- at a time so each sees the colours handed out before it. Idempotent on the
-- condition that makes it correct: only a NULL is filled, so the second run
-- selects nothing and an agent's colour is never replaced.
DO $$
DECLARE
  agent_id uuid;
BEGIN
  FOR agent_id IN
    SELECT id FROM agents WHERE avatar_color IS NULL ORDER BY created_at, id
  LOOP
    UPDATE agents SET avatar_color = next_agent_avatar_color() WHERE id = agent_id;
  END LOOP;
END;
$$;
