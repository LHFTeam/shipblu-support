CREATE TYPE "public"."category_audience" AS ENUM('merchant', 'recipient', 'any');--> statement-breakpoint
CREATE TYPE "public"."category_review_state" AS ENUM('auto', 'suggested', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."requester_kind" AS ENUM('merchant', 'recipient', 'prospect', 'other');--> statement-breakpoint
CREATE TYPE "public"."root_cause_owner" AS ENUM('courier', 'hub', 'merchant', 'recipient', 'platform', 'external', 'none');--> statement-breakpoint
CREATE TABLE "ticket_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"area" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"description" text,
	"audience" "category_audience" DEFAULT 'any' NOT NULL,
	"is_detectable" boolean DEFAULT true NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"superseded_by_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_root_causes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"description" text,
	"owner" "root_cause_owner" NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_categories" (
	"conversation_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"source" "link_source" DEFAULT 'detected' NOT NULL,
	"review_state" "category_review_state" DEFAULT 'auto' NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"detected_in_message_id" uuid,
	"rule_key" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detector_version" integer DEFAULT 0 NOT NULL,
	"assigned_by_agent_id" uuid,
	"reviewed_by_agent_id" uuid,
	"reviewed_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_categories_conversation_id_category_id_pk" PRIMARY KEY("conversation_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "category_metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"category_key" text NOT NULL,
	"area" text NOT NULL,
	"channel" "channel" NOT NULL,
	"tickets_primary" integer DEFAULT 0 NOT NULL,
	"tickets_any" integer DEFAULT 0 NOT NULL,
	"assigned_auto" integer DEFAULT 0 NOT NULL,
	"assigned_suggested" integer DEFAULT 0 NOT NULL,
	"assigned_manual" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "root_cause_metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"cause_key" text NOT NULL,
	"owner" "root_cause_owner" NOT NULL,
	"channel" "channel" NOT NULL,
	"tickets_resolved" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "requester_kind" "requester_kind";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "root_cause_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "root_cause_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_categories" ADD CONSTRAINT "conversation_categories_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_categories" ADD CONSTRAINT "conversation_categories_category_id_ticket_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."ticket_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_categories" ADD CONSTRAINT "conversation_categories_detected_in_message_id_messages_id_fk" FOREIGN KEY ("detected_in_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_categories" ADD CONSTRAINT "conversation_categories_assigned_by_agent_id_agents_id_fk" FOREIGN KEY ("assigned_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_categories" ADD CONSTRAINT "conversation_categories_reviewed_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_categories_key_idx" ON "ticket_categories" USING btree ("key");--> statement-breakpoint
CREATE INDEX "ticket_categories_area_idx" ON "ticket_categories" USING btree ("area","position");--> statement-breakpoint
CREATE INDEX "ticket_categories_active_idx" ON "ticket_categories" USING btree ("is_active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_root_causes_key_idx" ON "ticket_root_causes" USING btree ("key");--> statement-breakpoint
CREATE INDEX "ticket_root_causes_owner_idx" ON "ticket_root_causes" USING btree ("owner","position");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_categories_primary_idx" ON "conversation_categories" USING btree ("conversation_id") WHERE "conversation_categories"."is_primary";--> statement-breakpoint
CREATE INDEX "conversation_categories_key_idx" ON "conversation_categories" USING btree ("category_key","first_seen_at");--> statement-breakpoint
CREATE INDEX "conversation_categories_category_idx" ON "conversation_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "conversation_categories_review_idx" ON "conversation_categories" USING btree ("confidence","first_seen_at") WHERE "conversation_categories"."review_state" = 'suggested';--> statement-breakpoint
CREATE UNIQUE INDEX "category_metrics_daily_dimensions_idx" ON "category_metrics_daily" USING btree ("day","category_key","channel");--> statement-breakpoint
CREATE INDEX "category_metrics_daily_day_idx" ON "category_metrics_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "category_metrics_daily_area_idx" ON "category_metrics_daily" USING btree ("area","day");--> statement-breakpoint
CREATE UNIQUE INDEX "root_cause_metrics_daily_dimensions_idx" ON "root_cause_metrics_daily" USING btree ("day","cause_key","channel");--> statement-breakpoint
CREATE INDEX "root_cause_metrics_daily_day_idx" ON "root_cause_metrics_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "root_cause_metrics_daily_owner_idx" ON "root_cause_metrics_daily" USING btree ("owner","day");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_root_cause_id_ticket_root_causes_id_fk" FOREIGN KEY ("root_cause_id") REFERENCES "public"."ticket_root_causes"("id") ON DELETE restrict ON UPDATE no action;