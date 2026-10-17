ALTER TYPE "public"."csat_answer_source" ADD VALUE 'meta_feedback';--> statement-breakpoint
ALTER TYPE "public"."csat_answer_source" ADD VALUE 'meta_quick_reply';--> statement-breakpoint
ALTER TYPE "public"."csat_delivery" ADD VALUE 'meta_template';--> statement-breakpoint
ALTER TYPE "public"."csat_delivery" ADD VALUE 'meta_quick_reply';--> statement-breakpoint
ALTER TABLE "csat_settings" ADD COLUMN "privacy_url" text;--> statement-breakpoint
ALTER TABLE "csat_settings" ADD COLUMN "meta_expires_in_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "csat_settings" ADD COLUMN "last_template_refusal" text;--> statement-breakpoint
ALTER TABLE "csat_settings" ADD COLUMN "last_template_refusal_at" timestamp with time zone;