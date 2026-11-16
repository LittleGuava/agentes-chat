CREATE TABLE "health_issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"signature" text NOT NULL,
	"title" text NOT NULL,
	"source" text,
	"subject" text,
	"agent_id" uuid,
	"count" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "health_issues_orgId_signature_unique" UNIQUE("org_id","signature")
);
--> statement-breakpoint
CREATE TABLE "health_occurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "health_occurrences_orgId_ref_unique" UNIQUE("org_id","ref")
);
--> statement-breakpoint
ALTER TABLE "health_issues" ADD CONSTRAINT "health_issues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_occurrences" ADD CONSTRAINT "health_occurrences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_occurrences" ADD CONSTRAINT "health_occurrences_issue_id_health_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."health_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_issues_org_id_last_at_index" ON "health_issues" USING btree ("org_id","last_at");--> statement-breakpoint
CREATE INDEX "health_occurrences_issue_id_at_index" ON "health_occurrences" USING btree ("issue_id","at");--> statement-breakpoint
CREATE INDEX "health_occurrences_at_index" ON "health_occurrences" USING btree ("at");