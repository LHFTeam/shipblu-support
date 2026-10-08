CREATE TYPE "public"."suggestion_edit" AS ENUM('unchanged', 'extended', 'reworded');--> statement-breakpoint
CREATE TABLE "canned_suggestion_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_agent_id" uuid
);
--> statement-breakpoint
CREATE TABLE "canned_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid,
	"anchor_message_id" uuid,
	"channel" "channel" NOT NULL,
	"customer_locale" text,
	"request_version" text NOT NULL,
	"history_count" smallint DEFAULT 0 NOT NULL,
	"offered_ids" uuid[] DEFAULT '{}' NOT NULL,
	"model" text,
	"choice" text,
	"canned_response_id" uuid,
	"canned_title" text,
	"probability" double precision,
	"confidence" double precision,
	"probabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"shown_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"message_id" uuid,
	"replied_at" timestamp with time zone,
	"sent_choice" text,
	"sent_canned_response_id" uuid,
	"sent_canned_title" text,
	"sent_locale" text,
	"sent_matches" boolean,
	"sent_edit" "suggestion_edit"
);
--> statement-breakpoint
ALTER TABLE "canned_suggestion_settings" ADD CONSTRAINT "canned_suggestion_settings_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_suggestions" ADD CONSTRAINT "canned_suggestions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_suggestions" ADD CONSTRAINT "canned_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_suggestions" ADD CONSTRAINT "canned_suggestions_anchor_message_id_messages_id_fk" FOREIGN KEY ("anchor_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_suggestions" ADD CONSTRAINT "canned_suggestions_canned_response_id_canned_responses_id_fk" FOREIGN KEY ("canned_response_id") REFERENCES "public"."canned_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_suggestions" ADD CONSTRAINT "canned_suggestions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_suggestions" ADD CONSTRAINT "canned_suggestions_sent_canned_response_id_canned_responses_id_fk" FOREIGN KEY ("sent_canned_response_id") REFERENCES "public"."canned_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canned_suggestions_anchor_idx" ON "canned_suggestions" USING btree ("conversation_id","agent_id","anchor_message_id");--> statement-breakpoint
CREATE INDEX "canned_suggestions_created_idx" ON "canned_suggestions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "canned_suggestions_canned_idx" ON "canned_suggestions" USING btree ("canned_response_id");--> statement-breakpoint
CREATE INDEX "canned_suggestions_sent_canned_idx" ON "canned_suggestions" USING btree ("sent_canned_response_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canned_suggestions_message_idx" ON "canned_suggestions" USING btree ("message_id");