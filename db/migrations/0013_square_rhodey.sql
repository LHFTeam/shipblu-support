ALTER TABLE "contact_identities" ADD COLUMN "profile_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "avatar_path" text;