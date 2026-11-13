CREATE TABLE "api_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text NOT NULL,
	"forwarded_for" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "api_sessions" ADD CONSTRAINT "api_sessions_identity_id_contact_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."contact_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_sessions_identity_idx" ON "api_sessions" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "api_sessions_expires_idx" ON "api_sessions" USING btree ("expires_at");