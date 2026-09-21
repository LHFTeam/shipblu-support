CREATE TABLE "ai_category_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"run_label" text NOT NULL,
	"model" text,
	"with_context" boolean DEFAULT false NOT NULL,
	"predicted_key" text,
	"probability" double precision,
	"confidence" double precision,
	"probabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules_keys" text[] DEFAULT '{}' NOT NULL,
	"rules_top_confidence" double precision,
	"input_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_category_runs" ADD CONSTRAINT "ai_category_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_category_runs" ADD CONSTRAINT "ai_category_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_category_runs_label_message_idx" ON "ai_category_runs" USING btree ("run_label","message_id");--> statement-breakpoint
CREATE INDEX "ai_category_runs_label_idx" ON "ai_category_runs" USING btree ("run_label","created_at");--> statement-breakpoint
CREATE INDEX "ai_category_runs_conversation_idx" ON "ai_category_runs" USING btree ("conversation_id");