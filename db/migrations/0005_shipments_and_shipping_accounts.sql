CREATE TYPE "public"."link_source" AS ENUM('detected', 'manual', 'platform');--> statement-breakpoint
CREATE TYPE "public"."shipment_sync_state" AS ENUM('stub', 'synced', 'not_found');--> statement-breakpoint
CREATE TABLE "contact_shipping_accounts" (
	"contact_id" uuid NOT NULL,
	"shipping_account_id" uuid NOT NULL,
	"link_source" "link_source" DEFAULT 'manual' NOT NULL,
	"linked_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_shipping_accounts_contact_id_shipping_account_id_pk" PRIMARY KEY("contact_id","shipping_account_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_shipments" (
	"conversation_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"link_source" "link_source" DEFAULT 'manual' NOT NULL,
	"detected_in_message_id" uuid,
	"linked_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_shipments_conversation_id_shipment_id_pk" PRIMARY KEY("conversation_id","shipment_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_shipping_accounts" (
	"conversation_id" uuid NOT NULL,
	"shipping_account_id" uuid NOT NULL,
	"link_source" "link_source" DEFAULT 'manual' NOT NULL,
	"detected_in_message_id" uuid,
	"linked_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_shipping_accounts_conversation_id_shipping_account_id_pk" PRIMARY KEY("conversation_id","shipping_account_id")
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracking_number" text NOT NULL,
	"shipping_account_id" uuid,
	"shipper_contact_id" uuid,
	"recipient_contact_id" uuid,
	"status_label" text,
	"status_at" timestamp with time zone,
	"sync_state" "shipment_sync_state" DEFAULT 'stub' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" "source_system" DEFAULT 'native' NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sbid" text NOT NULL,
	"name" text,
	"company_id" uuid,
	"sync_state" "shipment_sync_state" DEFAULT 'stub' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"source_system" "source_system" DEFAULT 'native' NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_shipper" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_recipient" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_shipping_accounts" ADD CONSTRAINT "contact_shipping_accounts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_shipping_accounts" ADD CONSTRAINT "contact_shipping_accounts_shipping_account_id_shipping_accounts_id_fk" FOREIGN KEY ("shipping_account_id") REFERENCES "public"."shipping_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_shipping_accounts" ADD CONSTRAINT "contact_shipping_accounts_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipments" ADD CONSTRAINT "conversation_shipments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipments" ADD CONSTRAINT "conversation_shipments_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipments" ADD CONSTRAINT "conversation_shipments_detected_in_message_id_messages_id_fk" FOREIGN KEY ("detected_in_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipments" ADD CONSTRAINT "conversation_shipments_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipping_accounts" ADD CONSTRAINT "conversation_shipping_accounts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipping_accounts" ADD CONSTRAINT "conversation_shipping_accounts_shipping_account_id_shipping_accounts_id_fk" FOREIGN KEY ("shipping_account_id") REFERENCES "public"."shipping_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipping_accounts" ADD CONSTRAINT "conversation_shipping_accounts_detected_in_message_id_messages_id_fk" FOREIGN KEY ("detected_in_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shipping_accounts" ADD CONSTRAINT "conversation_shipping_accounts_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_shipping_account_id_shipping_accounts_id_fk" FOREIGN KEY ("shipping_account_id") REFERENCES "public"."shipping_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_shipper_contact_id_contacts_id_fk" FOREIGN KEY ("shipper_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_recipient_contact_id_contacts_id_fk" FOREIGN KEY ("recipient_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_accounts" ADD CONSTRAINT "shipping_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_shipping_accounts_account_idx" ON "contact_shipping_accounts" USING btree ("shipping_account_id");--> statement-breakpoint
CREATE INDEX "conversation_shipments_shipment_idx" ON "conversation_shipments" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_shipping_accounts_account_idx" ON "conversation_shipping_accounts" USING btree ("shipping_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_external_idx" ON "shipments" USING btree ("source_system","external_id");--> statement-breakpoint
CREATE INDEX "shipments_account_idx" ON "shipments" USING btree ("shipping_account_id");--> statement-breakpoint
CREATE INDEX "shipments_shipper_idx" ON "shipments" USING btree ("shipper_contact_id");--> statement-breakpoint
CREATE INDEX "shipments_recipient_idx" ON "shipments" USING btree ("recipient_contact_id");--> statement-breakpoint
CREATE INDEX "shipments_sync_idx" ON "shipments" USING btree ("sync_state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_accounts_sbid_idx" ON "shipping_accounts" USING btree ("sbid");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_accounts_external_idx" ON "shipping_accounts" USING btree ("source_system","external_id");--> statement-breakpoint
CREATE INDEX "shipping_accounts_company_idx" ON "shipping_accounts" USING btree ("company_id");