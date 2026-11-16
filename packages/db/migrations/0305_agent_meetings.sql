CREATE TABLE "agent_meetings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_id" uuid,
	"run_id" uuid,
	"requested_by_user_id" text,
	"platform" text NOT NULL,
	"url" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'joining' NOT NULL,
	"error" text,
	"joined_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"notice_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD CONSTRAINT "agent_meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD CONSTRAINT "agent_meetings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD CONSTRAINT "agent_meetings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD CONSTRAINT "agent_meetings_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_meetings_one_live" ON "agent_meetings" USING btree ("agent_id") WHERE "agent_meetings"."status" in ('joining', 'waiting', 'in_call');--> statement-breakpoint
CREATE INDEX "agent_meetings_org_id_created_at_index" ON "agent_meetings" USING btree ("org_id","created_at");