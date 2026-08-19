CREATE TYPE "public"."sla_hours_source" AS ENUM('group', 'schedule', 'round_the_clock');--> statement-breakpoint
ALTER TABLE "sla_policies" ADD COLUMN "hours_source" "sla_hours_source" DEFAULT 'group' NOT NULL;--> statement-breakpoint
-- Existing policies keep exactly the behaviour they had before the column
-- existed: a schedule named on the policy meant "count against that schedule",
-- and no schedule meant round the clock. Without this backfill every existing
-- policy would silently adopt the new default and start counting against its
-- tickets' group hours instead — including the 24/7 ones.
--
-- New policies default to 'group', which is the setting that respects both the
-- company schedule and a group's own.
UPDATE "sla_policies"
SET "hours_source" = CASE
  WHEN "business_hours_id" IS NULL THEN 'round_the_clock'::"public"."sla_hours_source"
  ELSE 'schedule'::"public"."sla_hours_source"
END;
