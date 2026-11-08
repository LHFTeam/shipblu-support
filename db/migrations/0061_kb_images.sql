CREATE TABLE "kb_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_path" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_images_storage_path_idx" ON "kb_images" USING btree ("storage_path");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_images_source_url_idx" ON "kb_images" USING btree ("source_url");