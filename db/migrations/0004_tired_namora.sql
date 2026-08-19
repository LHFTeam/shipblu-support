ALTER TYPE "public"."channel" ADD VALUE 'whatsapp_bot';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_idx" ON "channels" USING btree ("name");