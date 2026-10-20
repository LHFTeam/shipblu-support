CREATE TABLE "extension_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
ALTER TABLE "extension_sessions" ADD CONSTRAINT "extension_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_sessions_agent_idx" ON "extension_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "extension_sessions_expires_idx" ON "extension_sessions" USING btree ("expires_at");