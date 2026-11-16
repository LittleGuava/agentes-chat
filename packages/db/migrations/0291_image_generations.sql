CREATE TABLE "image_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_generations_org_id_created_at_index" ON "image_generations" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "image_generations_run_id_index" ON "image_generations" USING btree ("run_id");