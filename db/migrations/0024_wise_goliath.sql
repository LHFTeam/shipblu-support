CREATE TYPE "public"."availability_reason" AS ENUM('self', 'idle', 'supervisor');--> statement-breakpoint
CREATE TABLE "presence_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"auto_away_after_mins" integer,
	"auto_signout_after_mins" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_agent_id" uuid
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_input_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "accepting_off_reason" "availability_reason";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "accepting_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "presence_policy" ADD CONSTRAINT "presence_policy_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_activity_idx" ON "sessions" USING btree ("last_activity_at");