ALTER TABLE "organization_settings" ADD COLUMN "meeting_notes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD COLUMN "transcript" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD COLUMN "cost_nano_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_meetings" ADD CONSTRAINT "agent_meetings_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;