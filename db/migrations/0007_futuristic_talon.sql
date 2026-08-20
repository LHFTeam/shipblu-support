CREATE TYPE "public"."internal_recipient_kind" AS ENUM('team', 'vendor');--> statement-breakpoint
CREATE TYPE "public"."side_conversation_state" AS ENUM('open', 'done');--> statement-breakpoint
CREATE TABLE "internal_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"kind" "internal_recipient_kind" DEFAULT 'team' NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "side_conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"side_conversation_id" uuid NOT NULL,
	"direction" "direction" NOT NULL,
	"author_agent_id" uuid,
	"from_address" text,
	"from_name" text,
	"to_addresses" text[] DEFAULT '{}' NOT NULL,
	"cc_addresses" text[] DEFAULT '{}' NOT NULL,
	"body_html" text,
	"body_text" text DEFAULT '' NOT NULL,
	"raw_body" text,
	"channel_message_id" text,
	"in_reply_to" text,
	"delivery_status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"delivery_error" text,
	"delivered_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body_text, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "side_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigserial NOT NULL,
	"conversation_id" uuid NOT NULL,
	"anchor_message_id" uuid,
	"channel" "channel" DEFAULT 'email' NOT NULL,
	"subject" text NOT NULL,
	"state" "side_conversation_state" DEFAULT 'open' NOT NULL,
	"location_id" uuid,
	"recipient_id" uuid,
	"to_addresses" text[] DEFAULT '{}' NOT NULL,
	"cc_addresses" text[] DEFAULT '{}' NOT NULL,
	"created_by_agent_id" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "side_message_id" uuid;--> statement-breakpoint
ALTER TABLE "side_conversation_messages" ADD CONSTRAINT "side_conversation_messages_side_conversation_id_side_conversations_id_fk" FOREIGN KEY ("side_conversation_id") REFERENCES "public"."side_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_conversation_messages" ADD CONSTRAINT "side_conversation_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_conversations" ADD CONSTRAINT "side_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_conversations" ADD CONSTRAINT "side_conversations_anchor_message_id_messages_id_fk" FOREIGN KEY ("anchor_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_conversations" ADD CONSTRAINT "side_conversations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_conversations" ADD CONSTRAINT "side_conversations_recipient_id_internal_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."internal_recipients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_conversations" ADD CONSTRAINT "side_conversations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_conversations" ADD CONSTRAINT "side_conversations_closed_by_agent_id_agents_id_fk" FOREIGN KEY ("closed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_recipients_email_idx" ON "internal_recipients" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "internal_recipients_name_idx" ON "internal_recipients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "internal_recipients_kind_idx" ON "internal_recipients" USING btree ("kind","name");--> statement-breakpoint
CREATE INDEX "side_conversation_messages_thread_idx" ON "side_conversation_messages" USING btree ("side_conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "side_conversation_messages_channel_idx" ON "side_conversation_messages" USING btree ("channel_message_id");--> statement-breakpoint
CREATE INDEX "side_conversation_messages_search_idx" ON "side_conversation_messages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "side_conversation_messages_delivery_idx" ON "side_conversation_messages" USING btree ("delivery_status");--> statement-breakpoint
CREATE UNIQUE INDEX "side_conversations_number_idx" ON "side_conversations" USING btree ("number");--> statement-breakpoint
CREATE INDEX "side_conversations_conversation_idx" ON "side_conversations" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "side_conversations_state_idx" ON "side_conversations" USING btree ("state","last_message_at");--> statement-breakpoint
CREATE INDEX "side_conversations_recipient_idx" ON "side_conversations" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "side_conversations_location_idx" ON "side_conversations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "attachments_side_message_idx" ON "attachments" USING btree ("side_message_id");