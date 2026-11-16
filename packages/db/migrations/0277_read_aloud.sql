CREATE TABLE "read_aloud_clips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"key" text NOT NULL,
	"user_id" text,
	"engine" text NOT NULL,
	"voice" text NOT NULL,
	"chars" integer NOT NULL,
	"storage_config_id" uuid,
	"blob_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "read_aloud_voice" text;--> statement-breakpoint
ALTER TABLE "read_aloud_clips" ADD CONSTRAINT "read_aloud_clips_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_aloud_clips" ADD CONSTRAINT "read_aloud_clips_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_aloud_clips" ADD CONSTRAINT "read_aloud_clips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "read_aloud_clips_org_id_message_id_key_index" ON "read_aloud_clips" USING btree ("org_id","message_id","key");--> statement-breakpoint
CREATE INDEX "read_aloud_clips_user_id_created_at_index" ON "read_aloud_clips" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "read_aloud_clips_created_at_index" ON "read_aloud_clips" USING btree ("created_at");