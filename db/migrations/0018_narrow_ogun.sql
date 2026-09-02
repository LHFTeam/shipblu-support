CREATE TABLE "ticket_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_ar" text DEFAULT '' NOT NULL,
	"name_en" text DEFAULT '' NOT NULL,
	"description_ar" text DEFAULT '' NOT NULL,
	"description_en" text DEFAULT '' NOT NULL,
	"elements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_sign_in" boolean DEFAULT true NOT NULL,
	"show_on_help_centre" boolean DEFAULT true NOT NULL,
	"show_in_console" boolean DEFAULT true NOT NULL,
	"default_group_id" uuid,
	"default_priority" "priority",
	"default_type" text,
	"default_tags" text[] DEFAULT '{}' NOT NULL,
	"subject_template" text,
	"confirmation_ar" text DEFAULT '' NOT NULL,
	"confirmation_en" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_fields" ADD COLUMN "label_ar" text;--> statement-breakpoint
ALTER TABLE "ticket_fields" ADD COLUMN "label_en" text;--> statement-breakpoint
ALTER TABLE "ticket_fields" ADD COLUMN "validation" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "form_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_forms" ADD CONSTRAINT "ticket_forms_default_group_id_groups_id_fk" FOREIGN KEY ("default_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_forms_slug_idx" ON "ticket_forms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ticket_forms_position_idx" ON "ticket_forms" USING btree ("position");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_form_id_ticket_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."ticket_forms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_form_idx" ON "conversations" USING btree ("form_id","created_at");