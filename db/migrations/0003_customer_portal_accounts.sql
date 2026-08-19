CREATE TYPE "public"."contact_token_purpose" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TABLE "contact_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "contact_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"purpose" "contact_token_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_sessions" ADD CONSTRAINT "contact_sessions_identity_id_contact_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."contact_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tokens" ADD CONSTRAINT "contact_tokens_identity_id_contact_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."contact_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_sessions_identity_idx" ON "contact_sessions" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "contact_sessions_expires_idx" ON "contact_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "contact_tokens_identity_idx" ON "contact_tokens" USING btree ("identity_id","purpose");--> statement-breakpoint
CREATE INDEX "contact_tokens_expires_idx" ON "contact_tokens" USING btree ("expires_at");