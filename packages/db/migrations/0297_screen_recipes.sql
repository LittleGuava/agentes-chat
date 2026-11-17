CREATE TABLE "screen_recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"screen_key" text NOT NULL,
	"screen" text NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screen_recipes" ADD CONSTRAINT "screen_recipes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_recipes" ADD CONSTRAINT "screen_recipes_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_recipes" ADD CONSTRAINT "screen_recipes_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "screen_recipes_screen_key_screen_name_index" ON "screen_recipes" USING btree ("screen_key","screen","name");--> statement-breakpoint
CREATE INDEX "screen_recipes_agent_id_index" ON "screen_recipes" USING btree ("agent_id");