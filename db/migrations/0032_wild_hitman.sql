CREATE TABLE "ai_priority_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"mode" text NOT NULL,
	"model" text,
	"with_context" boolean DEFAULT false NOT NULL,
	"predicted" "priority",
	"probability" double precision,
	"confidence" double precision,
	"probabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority_before" "priority" NOT NULL,
	"outcome" text NOT NULL,
	"input_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_priority_runs" ADD CONSTRAINT "ai_priority_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_priority_runs" ADD CONSTRAINT "ai_priority_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_priority_runs_message_idx" ON "ai_priority_runs" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ai_priority_runs_conversation_idx" ON "ai_priority_runs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_priority_runs_created_idx" ON "ai_priority_runs" USING btree ("created_at");