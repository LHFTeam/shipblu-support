CREATE TABLE "admin_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_by_agent_id" uuid,
	"deleted_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_deletions" ADD CONSTRAINT "admin_deletions_deleted_by_agent_id_agents_id_fk" FOREIGN KEY ("deleted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_deletions_created_idx" ON "admin_deletions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_deletions_subject_idx" ON "admin_deletions" USING btree ("subject","subject_id");