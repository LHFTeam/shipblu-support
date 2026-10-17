CREATE TYPE "public"."csat_answer_source" AS ENUM('page', 'widget');--> statement-breakpoint
ALTER TYPE "public"."csat_delivery" ADD VALUE 'widget_card';--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD COLUMN "answer_source" "csat_answer_source";