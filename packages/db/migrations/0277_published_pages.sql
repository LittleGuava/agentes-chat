CREATE TABLE "published_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"token" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"run_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "published_pages_token_index" ON "published_pages" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "published_pages_live_artifact" ON "published_pages" USING btree ("artifact_id") WHERE "published_pages"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "published_pages_org_id_created_at_index" ON "published_pages" USING btree ("org_id","created_at");