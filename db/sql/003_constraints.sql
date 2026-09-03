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
