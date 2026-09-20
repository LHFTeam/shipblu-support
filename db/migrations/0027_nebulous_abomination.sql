CREATE TABLE "mobile_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"app" text DEFAULT 'myblu' NOT NULL,
	"install_id_hash" text NOT NULL,
	"subject" text,
	"verified" boolean DEFAULT false NOT NULL,
	"locale" text,
	"app_version" text,
	"platform" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "mobile_sessions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_sessions_contact_idx" ON "mobile_sessions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "mobile_sessions_expires_idx" ON "mobile_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mobile_sessions_install_idx" ON "mobile_sessions" USING btree ("app","install_id_hash");