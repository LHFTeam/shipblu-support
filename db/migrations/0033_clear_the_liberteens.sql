CREATE TABLE "whatsapp_onboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"channel_id" uuid,
	"default_group_id" uuid,
	"status" text NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_transient_error" text,
	"error" text,
	"started_by_agent_id" uuid,
	"started_by_label" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_onboardings" ADD CONSTRAINT "whatsapp_onboardings_default_group_id_groups_id_fk" FOREIGN KEY ("default_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_onboardings" ADD CONSTRAINT "whatsapp_onboardings_started_by_agent_id_agents_id_fk" FOREIGN KEY ("started_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_onboardings_phone_idx" ON "whatsapp_onboardings" USING btree ("phone_number_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_onboardings_live_idx" ON "whatsapp_onboardings" USING btree ("phone_number_id") WHERE "whatsapp_onboardings"."status" = 'exchanged';