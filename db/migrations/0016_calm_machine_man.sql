CREATE TABLE "shipment_phrases" (
	"key" text PRIMARY KEY NOT NULL,
	"ar" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "shipment_phrases" ADD CONSTRAINT "shipment_phrases_updated_by_agents_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;