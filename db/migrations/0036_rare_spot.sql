CREATE TABLE "csat_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"channel" "channel",
	"question_ar" text DEFAULT '' NOT NULL,
	"question_en" text DEFAULT '' NOT NULL,
	"intro_ar" text DEFAULT '' NOT NULL,
	"intro_en" text DEFAULT '' NOT NULL,
	"subtitle_ar" text DEFAULT '' NOT NULL,
	"subtitle_en" text DEFAULT '' NOT NULL,
	"button_ar" text DEFAULT '' NOT NULL,
	"button_en" text DEFAULT '' NOT NULL,
	"comment_prompt_ar" text DEFAULT '' NOT NULL,
	"comment_prompt_en" text DEFAULT '' NOT NULL,
	"thanks_ar" text DEFAULT '' NOT NULL,
	"thanks_en" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csat_rules_scope_key" UNIQUE NULLS NOT DISTINCT("group_id","channel")
);
--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "csat_rules" ADD CONSTRAINT "csat_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_rule_id_csat_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."csat_rules"("id") ON DELETE set null ON UPDATE no action;