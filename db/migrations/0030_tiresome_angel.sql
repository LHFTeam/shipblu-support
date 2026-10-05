ALTER TABLE "canned_responses" ADD COLUMN "seed_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "canned_responses_seed_key_idx" ON "canned_responses" USING btree ("seed_key");