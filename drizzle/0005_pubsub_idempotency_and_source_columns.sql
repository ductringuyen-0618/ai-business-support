CREATE TABLE "processed_pubsub_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_connections" ADD COLUMN "google_location_id" text;--> statement-breakpoint
ALTER TABLE "source_connections" ADD COLUMN "ready_email_sent_at" timestamp with time zone;