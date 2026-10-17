CREATE TABLE "rollup_days" (
	"day" date PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
