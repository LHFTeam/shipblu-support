CREATE TABLE "channel_owner_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"channel_name" text NOT NULL,
	"display_number" text,
	"from_agent_id" uuid,
	"from_label" text,
	"to_agent_id" uuid,
	"to_label" text,
	"changed_by_agent_id" uuid,
	"changed_by_label" text,
	"tickets_moved" integer DEFAULT 0 NOT NULL,
	"tickets_reassigned" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "accountable_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_owner_changes" ADD CONSTRAINT "channel_owner_changes_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_owner_changes" ADD CONSTRAINT "channel_owner_changes_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_owner_changes" ADD CONSTRAINT "channel_owner_changes_changed_by_agent_id_agents_id_fk" FOREIGN KEY ("changed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_owner_changes_channel_idx" ON "channel_owner_changes" USING btree ("channel_id","created_at");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_accountable_agent_id_agents_id_fk" FOREIGN KEY ("accountable_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;