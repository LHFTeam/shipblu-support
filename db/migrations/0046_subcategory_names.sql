ALTER TYPE "public"."category_audience" RENAME TO "subcategory_audience";--> statement-breakpoint
ALTER TYPE "public"."category_review_state" RENAME TO "subcategory_review_state";--> statement-breakpoint
ALTER TABLE "ticket_categories" RENAME TO "ticket_subcategories";--> statement-breakpoint
ALTER TABLE "conversation_categories" RENAME TO "conversation_subcategories";--> statement-breakpoint
ALTER TABLE "category_metrics_daily" RENAME TO "subcategory_metrics_daily";--> statement-breakpoint
ALTER TABLE "ai_category_runs" RENAME TO "ai_subcategory_runs";--> statement-breakpoint
ALTER TABLE "conversation_subcategories" RENAME COLUMN "category_id" TO "subcategory_id";--> statement-breakpoint
ALTER TABLE "conversation_subcategories" RENAME COLUMN "category_key" TO "subcategory_key";--> statement-breakpoint
ALTER TABLE "subcategory_metrics_daily" RENAME COLUMN "category_key" TO "subcategory_key";--> statement-breakpoint
ALTER TABLE "conversation_subcategories" DROP CONSTRAINT "conversation_categories_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_subcategories" DROP CONSTRAINT "conversation_categories_category_id_ticket_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_subcategories" DROP CONSTRAINT "conversation_categories_detected_in_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_subcategories" DROP CONSTRAINT "conversation_categories_assigned_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_subcategories" DROP CONSTRAINT "conversation_categories_reviewed_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_subcategory_runs" DROP CONSTRAINT "ai_category_runs_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_subcategory_runs" DROP CONSTRAINT "ai_category_runs_message_id_messages_id_fk";
--> statement-breakpoint
DROP INDEX "ticket_categories_key_idx";--> statement-breakpoint
DROP INDEX "ticket_categories_area_idx";--> statement-breakpoint
DROP INDEX "ticket_categories_active_idx";--> statement-breakpoint
DROP INDEX "conversation_categories_primary_idx";--> statement-breakpoint
DROP INDEX "conversation_categories_key_idx";--> statement-breakpoint
DROP INDEX "conversation_categories_category_idx";--> statement-breakpoint
DROP INDEX "conversation_categories_review_idx";--> statement-breakpoint
DROP INDEX "category_metrics_daily_dimensions_idx";--> statement-breakpoint
DROP INDEX "category_metrics_daily_day_idx";--> statement-breakpoint
DROP INDEX "category_metrics_daily_area_idx";--> statement-breakpoint
DROP INDEX "ai_category_runs_label_message_idx";--> statement-breakpoint
DROP INDEX "ai_category_runs_label_idx";--> statement-breakpoint
DROP INDEX "ai_category_runs_conversation_idx";--> statement-breakpoint
ALTER TABLE "conversation_subcategories" DROP CONSTRAINT "conversation_categories_conversation_id_category_id_pk";--> statement-breakpoint
ALTER TABLE "conversation_subcategories" ADD CONSTRAINT "conversation_subcategories_conversation_id_subcategory_id_pk" PRIMARY KEY("conversation_id","subcategory_id");--> statement-breakpoint
ALTER TABLE "conversation_subcategories" ADD CONSTRAINT "conversation_subcategories_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_subcategories" ADD CONSTRAINT "conversation_subcategories_subcategory_id_ticket_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."ticket_subcategories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_subcategories" ADD CONSTRAINT "conversation_subcategories_detected_in_message_id_messages_id_fk" FOREIGN KEY ("detected_in_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_subcategories" ADD CONSTRAINT "conversation_subcategories_assigned_by_agent_id_agents_id_fk" FOREIGN KEY ("assigned_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_subcategories" ADD CONSTRAINT "conversation_subcategories_reviewed_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subcategory_runs" ADD CONSTRAINT "ai_subcategory_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subcategory_runs" ADD CONSTRAINT "ai_subcategory_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_subcategories_key_idx" ON "ticket_subcategories" USING btree ("key");--> statement-breakpoint
CREATE INDEX "ticket_subcategories_area_idx" ON "ticket_subcategories" USING btree ("area","position");--> statement-breakpoint
CREATE INDEX "ticket_subcategories_active_idx" ON "ticket_subcategories" USING btree ("is_active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_subcategories_primary_idx" ON "conversation_subcategories" USING btree ("conversation_id") WHERE "conversation_subcategories"."is_primary";--> statement-breakpoint
CREATE INDEX "conversation_subcategories_key_idx" ON "conversation_subcategories" USING btree ("subcategory_key","first_seen_at");--> statement-breakpoint
CREATE INDEX "conversation_subcategories_subcategory_idx" ON "conversation_subcategories" USING btree ("subcategory_id");--> statement-breakpoint
CREATE INDEX "conversation_subcategories_review_idx" ON "conversation_subcategories" USING btree ("confidence","first_seen_at") WHERE "conversation_subcategories"."review_state" = 'suggested';--> statement-breakpoint
CREATE UNIQUE INDEX "subcategory_metrics_daily_dimensions_idx" ON "subcategory_metrics_daily" USING btree ("day","subcategory_key","channel");--> statement-breakpoint
CREATE INDEX "subcategory_metrics_daily_day_idx" ON "subcategory_metrics_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "subcategory_metrics_daily_area_idx" ON "subcategory_metrics_daily" USING btree ("area","day");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_subcategory_runs_label_message_idx" ON "ai_subcategory_runs" USING btree ("run_label","message_id");--> statement-breakpoint
CREATE INDEX "ai_subcategory_runs_label_idx" ON "ai_subcategory_runs" USING btree ("run_label","created_at");--> statement-breakpoint
CREATE INDEX "ai_subcategory_runs_conversation_idx" ON "ai_subcategory_runs" USING btree ("conversation_id");