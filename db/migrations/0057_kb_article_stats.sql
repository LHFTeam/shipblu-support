CREATE TABLE "kb_article_stats" (
	"article_id" uuid PRIMARY KEY NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"unhelpful_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_article_stats" ADD CONSTRAINT "kb_article_stats_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;