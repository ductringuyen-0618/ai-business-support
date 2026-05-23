CREATE TYPE "public"."channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TABLE "operator_channel_prefs" (
	"operator_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" time,
	"quiet_hours_end" time,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	CONSTRAINT "operator_channel_prefs_operator_id_channel_pk" PRIMARY KEY("operator_id","channel")
);
--> statement-breakpoint
ALTER TABLE "operator_channel_prefs" ADD CONSTRAINT "operator_channel_prefs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;