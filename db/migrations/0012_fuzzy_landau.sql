CREATE TABLE "auto_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"channel" "channel",
	"body_ar" text DEFAULT '' NOT NULL,
	"body_en" text DEFAULT '' NOT NULL,
	"holiday_body_ar" text DEFAULT '' NOT NULL,
	"holiday_body_en" text DEFAULT '' NOT NULL,
	"silent" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_responses_scope_key" UNIQUE NULLS NOT DISTINCT("group_id","channel")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "auto_responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auto_responses" ADD CONSTRAINT "auto_responses_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_responses_active_idx" ON "auto_responses" USING btree ("is_active");