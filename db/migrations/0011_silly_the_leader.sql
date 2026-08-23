CREATE TABLE "whatsapp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"waba_id" text NOT NULL,
	"token_env_var" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "whatsapp_templates_name_lang_idx";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "whatsapp_account_id" uuid;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD COLUMN "whatsapp_account_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_accounts_waba_idx" ON "whatsapp_accounts" USING btree ("waba_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_accounts_name_idx" ON "whatsapp_accounts" USING btree ("name");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_whatsapp_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_whatsapp_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_whatsapp_account_idx" ON "channels" USING btree ("whatsapp_account_id");--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_account_name_lang_idx" UNIQUE NULLS NOT DISTINCT("whatsapp_account_id","name","language");