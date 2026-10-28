CREATE TYPE "public"."routing_mode" AS ENUM('default_group', 'category_shadow', 'category');--> statement-breakpoint
CREATE TYPE "public"."routing_outcome" AS ENUM('taken', 'not_open', 'released', 'category', 'no_route_for_category', 'fallback', 'manual', 'rule');--> statement-breakpoint
CREATE TYPE "public"."routing_stage" AS ENUM('pending', 'holding', 'decided');--> statement-breakpoint
CREATE TABLE "routing_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid,
	"shadow" boolean NOT NULL,
	"stage" "routing_stage" DEFAULT 'pending' NOT NULL,
	"outcome" "routing_outcome",
	"from_group_id" uuid,
	"to_group_id" uuid,
	"category_id" uuid,
	"probability" double precision,
	"decided_by_agent_id" uuid,
	"decided_by_label" text,
	"message_id" uuid,
	"window_ends_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase_one_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"held_strategy" "assignment_strategy",
	"held_actor_label" text
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "routing_mode" "routing_mode" DEFAULT 'default_group' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "routing_window_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "routing_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_from_group_id_groups_id_fk" FOREIGN KEY ("from_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_to_group_id_groups_id_fk" FOREIGN KEY ("to_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_category_id_ticket_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."ticket_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_decisions_conversation_idx" ON "routing_decisions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "routing_decisions_channel_idx" ON "routing_decisions" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX "routing_decisions_message_idx" ON "routing_decisions" USING btree ("message_id");