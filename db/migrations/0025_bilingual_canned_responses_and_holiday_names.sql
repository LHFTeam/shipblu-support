ALTER TABLE "canned_responses" ALTER COLUMN "body_html" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "canned_responses" ALTER COLUMN "body_text" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "holidays" ALTER COLUMN "name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "canned_responses" ADD COLUMN "body_html_ar" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD COLUMN "body_text_ar" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD COLUMN "body_html_en" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD COLUMN "body_text_en" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "holidays" ADD COLUMN "name_ar" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "holidays" ADD COLUMN "name_en" text DEFAULT '' NOT NULL;