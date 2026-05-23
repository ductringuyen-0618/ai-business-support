CREATE TYPE "public"."source_backfill_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_connection_status" AS ENUM('pending', 'healthy', 'errored', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('google');--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"source" "source" NOT NULL,
	"oauth_access_token" text,
	"oauth_refresh_token" text,
	"oauth_expires_at" timestamp with time zone,
	"status" "source_connection_status" DEFAULT 'pending' NOT NULL,
	"backfill_status" "source_backfill_status" DEFAULT 'pending' NOT NULL,
	"loaded_count" integer DEFAULT 0 NOT NULL,
	"estimated_total" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "source_connections_business_id_source_unique" UNIQUE("business_id","source")
);
--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;