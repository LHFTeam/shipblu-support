CREATE TABLE "meta_app_role_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"account_id" text NOT NULL,
	"app_id" text NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "meta_app_role_events_key" ON "meta_app_role_events" USING btree ("platform","account_id","at","app_id");