DROP INDEX "metrics_daily_dimensions_idx";--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_category_id_ticket_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."ticket_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_slice_key" UNIQUE NULLS NOT DISTINCT("day","group_id","agent_id","channel","category_id");