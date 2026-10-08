CREATE TABLE "whatsapp_account_credentials" (
	"whatsapp_account_id" uuid PRIMARY KEY NOT NULL,
	"envelope" text NOT NULL,
	"key_id" text NOT NULL,
	"source" text NOT NULL,
	"token_type" text,
	"app_id" text,
	"scopes" jsonb,
	"business_id" text,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"data_access_expires_at" timestamp with time zone,
	"inspected_at" timestamp with time zone,
	"obtained_by_agent_id" uuid,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_refused_at" timestamp with time zone,
	"last_refusal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_credential_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"event" text NOT NULL,
	"key_id" text,
	"agent_id" uuid,
	"agent_label" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_account_credentials" ADD CONSTRAINT "whatsapp_account_credentials_whatsapp_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_account_credentials" ADD CONSTRAINT "whatsapp_account_credentials_obtained_by_agent_id_agents_id_fk" FOREIGN KEY ("obtained_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_credential_events" ADD CONSTRAINT "whatsapp_credential_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_credential_events_account_idx" ON "whatsapp_credential_events" USING btree ("whatsapp_account_id","created_at");