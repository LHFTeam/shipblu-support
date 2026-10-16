CREATE TYPE "public"."csat_delivery" AS ENUM('email_link', 'text_link');--> statement-breakpoint
CREATE TYPE "public"."csat_status" AS ENUM('sent', 'answered', 'skipped', 'expired');--> statement-breakpoint
CREATE TABLE "csat_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"delay_minutes" integer DEFAULT 30 NOT NULL,
	"meta_delay_minutes" integer,
	"resurvey_after_days" integer DEFAULT 14 NOT NULL,
	"survey_email" boolean DEFAULT false NOT NULL,
	"survey_webchat" boolean DEFAULT false NOT NULL,
	"survey_facebook" boolean DEFAULT false NOT NULL,
	"survey_instagram" boolean DEFAULT false NOT NULL,
	"survey_api" boolean DEFAULT false NOT NULL,
	"survey_rule_resolved" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_agent_id" uuid
);
--> statement-breakpoint
ALTER TABLE "csat_surveys" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "csat_suppressed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "status" "csat_status" DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "channel" "channel";--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "delivery" "csat_delivery";--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "csat_settings" ADD CONSTRAINT "csat_settings_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csat_surveys_created_idx" ON "csat_surveys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "csat_surveys_open_idx" ON "csat_surveys" USING btree ("conversation_id") WHERE "csat_surveys"."status" = 'sent';