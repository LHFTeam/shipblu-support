CREATE TABLE "api_tickets" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"tracking_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tickets" ADD CONSTRAINT "api_tickets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tickets" ADD CONSTRAINT "api_tickets_identity_id_contact_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."contact_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tickets_identity_idx" ON "api_tickets" USING btree ("identity_id");