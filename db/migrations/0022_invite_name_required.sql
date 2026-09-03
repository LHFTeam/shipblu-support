-- Backfill before the constraint. Production code still writes NULL until this
-- deploy lands, so any invite created in the meantime would otherwise fail
-- `SET NOT NULL` — and db:migrate is a preDeployCommand, so that failure aborts
-- the whole release rather than just this change.
--
-- The address rather than a placeholder: the activation page keeps the name
-- editable, so an invitee who arrives to find their email in the name field can
-- correct it, and no row has to be thrown away to get the column locked down.
-- Blank is folded in with NULL because db/sql adds a CHECK against both.
UPDATE "invites" SET "name" = "email" WHERE "name" IS NULL OR btrim("name") = '';--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "name" SET NOT NULL;
