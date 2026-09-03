-- Post-migration SQL: constraints Drizzle's schema DSL cannot express.
--
-- Every statement here MUST be idempotent. db/migrate.ts re-runs this file after
-- every drizzle migration, and Postgres has no ADD CONSTRAINT IF NOT EXISTS, so
-- each one is guarded on pg_constraint.

-- --------------------------------------------------------------------------
-- invites.name is required, and NOT NULL is only half of that
--
-- The column being NOT NULL is what the schema can say; it does not exclude the
-- empty string, and '' is exactly what a scripted POST or a future second write
-- path would produce. Everything downstream reasons from "there is a name":
-- the invitation greets the invitee by it, the activation page presents it as
-- already answered, and acceptInvite copies it onto the agent record. With ''
-- all three degrade quietly — "Hi ," in somebody's inbox, an empty required
-- field on the page that promised there was nothing to fill in.
--
-- So the guarantee lives here rather than in the one server action that
-- currently happens to check it.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invites_name_not_blank'
  ) THEN
    ALTER TABLE invites
      ADD CONSTRAINT invites_name_not_blank CHECK (btrim(name) <> '');
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- presence_policy holds exactly one row
--
-- The table is a singleton: one company-wide answer to "when is somebody idle".
-- Nothing in the schema says so, and a second row would not fail anything — it
-- would be picked up or not depending on which one the read happened to order
-- first, so half the fleet would enforce one timeout and half the other, with
-- no error anywhere to explain it.
--
-- Pinning the primary key to 1 makes the upsert in the settings action the only
-- shape that can work, and makes a stray INSERT fail loudly at the moment it is
-- written rather than quietly at the moment it is read.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'presence_policy_singleton'
  ) THEN
    ALTER TABLE presence_policy
      ADD CONSTRAINT presence_policy_singleton CHECK (id = 1);
  END IF;
END $$;

-- The windows are minutes, and a non-positive one is not a shorter timeout — it
-- is a timeout that has already expired for everybody, which on the sign-out
-- side signs the whole team out on the next sweep. The action validates the
-- range too; this is the half that also holds for a hand-written UPDATE against
-- the database, which is how a number nobody would type through the form gets
-- in.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'presence_policy_windows_positive'
  ) THEN
    ALTER TABLE presence_policy
      ADD CONSTRAINT presence_policy_windows_positive CHECK (
        (auto_away_after_mins IS NULL OR auto_away_after_mins > 0)
        AND (auto_signout_after_mins IS NULL OR auto_signout_after_mins > 0)
      );
  END IF;
END $$;

-- Signing out before marking away makes the away state unreachable: the session
-- is destroyed, the stream closes, and the agent goes offline without ever
-- having been away. The ordering is a property of the pair, so it belongs with
-- the pair rather than only in the form that happens to write them today.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'presence_policy_signout_after_away'
  ) THEN
    ALTER TABLE presence_policy
      ADD CONSTRAINT presence_policy_signout_after_away CHECK (
        auto_away_after_mins IS NULL
        OR auto_signout_after_mins IS NULL
        OR auto_signout_after_mins >= auto_away_after_mins
      );
  END IF;
END $$;
