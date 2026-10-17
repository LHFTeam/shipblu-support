ALTER TABLE "metrics_daily" ADD COLUMN "csat_sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "csat_skipped_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "csat_rating_1" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "csat_rating_2" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "csat_rating_3" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "csat_rating_4" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "csat_rating_5" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "csat_surveys_sent_idx" ON "csat_surveys" USING btree ("sent_at");