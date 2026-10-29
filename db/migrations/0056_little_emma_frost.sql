CREATE TABLE "agent_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"agent_label" text NOT NULL,
	"field" text NOT NULL,
	"from_value" text NOT NULL,
	"to_value" text NOT NULL,
	"changed_by_agent_id" uuid,
	"changed_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_changed_by_agent_id_agents_id_fk" FOREIGN KEY ("changed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_changes_agent_idx" ON "agent_changes" USING btree ("agent_id","created_at");