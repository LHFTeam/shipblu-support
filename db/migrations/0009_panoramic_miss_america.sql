CREATE TABLE "agent_presence_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"accepting" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_backlog_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"awaiting_reply_count" integer DEFAULT 0 NOT NULL,
	"breached_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_focus_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"agent_id" uuid NOT NULL,
	"first_online_at" timestamp with time zone,
	"last_online_at" timestamp with time zone,
	"scheduled_start_at" timestamp with time zone,
	"scheduled_end_at" timestamp with time zone,
	"online_seconds" integer DEFAULT 0 NOT NULL,
	"accepting_seconds" integer DEFAULT 0 NOT NULL,
	"online_within_hours_seconds" integer DEFAULT 0 NOT NULL,
	"scheduled_seconds" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"longest_session_seconds" integer DEFAULT 0 NOT NULL,
	"assigned_count" integer DEFAULT 0 NOT NULL,
	"touched_count" integer DEFAULT 0 NOT NULL,
	"public_replies" integer DEFAULT 0 NOT NULL,
	"private_notes" integer DEFAULT 0 NOT NULL,
	"transferred_away_count" integer DEFAULT 0 NOT NULL,
	"reclaimed_from_count" integer DEFAULT 0 NOT NULL,
	"open_at_day_end" integer,
	"pending_at_day_end" integer,
	"focus_seconds" integer DEFAULT 0 NOT NULL,
	"conversations_focused" integer DEFAULT 0 NOT NULL,
	"reopened_after_resolve_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_presence_intervals" ADD CONSTRAINT "agent_presence_intervals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_backlog_snapshots" ADD CONSTRAINT "agent_backlog_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_focus_intervals" ADD CONSTRAINT "agent_focus_intervals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_focus_intervals" ADD CONSTRAINT "agent_focus_intervals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_metrics_daily" ADD CONSTRAINT "agent_metrics_daily_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_presence_intervals_agent_idx" ON "agent_presence_intervals" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_presence_intervals_open_idx" ON "agent_presence_intervals" USING btree ("agent_id","last_beat_at") WHERE "agent_presence_intervals"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "agent_backlog_snapshots_agent_idx" ON "agent_backlog_snapshots" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "agent_focus_intervals_agent_idx" ON "agent_focus_intervals" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_focus_intervals_conversation_idx" ON "agent_focus_intervals" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_focus_intervals_open_idx" ON "agent_focus_intervals" USING btree ("agent_id","last_beat_at") WHERE "agent_focus_intervals"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_metrics_daily_dimensions_idx" ON "agent_metrics_daily" USING btree ("day","agent_id");--> statement-breakpoint
CREATE INDEX "agent_metrics_daily_day_idx" ON "agent_metrics_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "conversation_events_created_idx" ON "conversation_events" USING btree ("created_at");