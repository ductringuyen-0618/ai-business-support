CREATE TABLE "classifications" (
	"review_id" uuid PRIMARY KEY NOT NULL,
	"prompt_version" text NOT NULL,
	"is_incident" boolean NOT NULL,
	"severity" text,
	"themes" jsonb NOT NULL,
	"sentiment" text NOT NULL,
	"suggested_reply" text NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_connection_id" uuid NOT NULL,
	"source" "source" NOT NULL,
	"source_review_id" text NOT NULL,
	"star_rating" integer NOT NULL,
	"review_text" text,
	"reviewer_display_name" text,
	"redacted_text" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_source_connection_id_source_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."source_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_source_source_review_id_unique" ON "reviews" USING btree ("source","source_review_id");