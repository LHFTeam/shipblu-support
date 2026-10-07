ALTER TABLE "canned_responses" ADD COLUMN "usage_count_ar" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD COLUMN "usage_count_en" integer DEFAULT 0 NOT NULL;