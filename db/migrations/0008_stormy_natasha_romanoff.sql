CREATE TYPE "public"."assignment_strategy" AS ENUM('manual', 'round_robin', 'load_balanced');--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_accepting_tickets" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "max_open_tickets" integer;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "assignment_strategy" "assignment_strategy" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "match_skills" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "skill_timeout_mins" integer;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "default_max_open_tickets" integer;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "assign_within_hours_only" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "reclaim_after_mins" integer;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "last_assigned_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skills_skill_idx" ON "agent_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_idx" ON "skills" USING btree ("name");--> statement-breakpoint
CREATE INDEX "skills_position_idx" ON "skills" USING btree ("position");--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_last_assigned_agent_id_agents_id_fk" FOREIGN KEY ("last_assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;