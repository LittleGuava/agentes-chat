CREATE TABLE "meeting_watches" (
	"routine_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"lead_minutes" integer DEFAULT 15 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_watches" ADD CONSTRAINT "meeting_watches_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_watches" ADD CONSTRAINT "meeting_watches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_watches_org_id_index" ON "meeting_watches" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "meeting_watches_next_check_at_index" ON "meeting_watches" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "meeting_watches_connection_id_index" ON "meeting_watches" USING btree ("connection_id");