CREATE TABLE "ai_category_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"message_created_at" timestamp with time zone NOT NULL,
	"run_label" text NOT NULL,
	"mode" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"model" text,
	"with_context" boolean DEFAULT false NOT NULL,
	"predicted_key" text,
	"probability" double precision,
	"confidence" double precision,
	"probabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"min_probability" double precision,
	"category_key_before" text,
	"outcome" text NOT NULL,
	"baseline_category_key" text,
	"baseline_subcategory_keys" text[] DEFAULT '{}' NOT NULL,
	"channel" "channel" NOT NULL,
	"channel_id" uuid,
	"has_shipment" boolean DEFAULT false NOT NULL,
	"requester_kind" "requester_kind",
	"input_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_ai_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"min_probability" double precision DEFAULT 0.6 NOT NULL,
	"routing_window_minutes" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_agent_id" uuid
);
--> statement-breakpoint
ALTER TABLE "ai_category_runs" ADD CONSTRAINT "ai_category_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_category_runs" ADD CONSTRAINT "ai_category_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_category_runs" ADD CONSTRAINT "ai_category_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_ai_settings" ADD CONSTRAINT "category_ai_settings_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_category_runs_message_label_idx" ON "ai_category_runs" USING btree ("message_id","run_label");--> statement-breakpoint
CREATE INDEX "ai_category_runs_conversation_idx" ON "ai_category_runs" USING btree ("conversation_id","message_created_at");--> statement-breakpoint
CREATE INDEX "ai_category_runs_label_idx" ON "ai_category_runs" USING btree ("run_label","created_at");