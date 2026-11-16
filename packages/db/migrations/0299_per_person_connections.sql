CREATE TABLE "connector_personal_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"composio_account_id" text NOT NULL,
	"account_label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "per_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "for_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_personal_accounts" ADD CONSTRAINT "connector_personal_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_personal_accounts" ADD CONSTRAINT "connector_personal_accounts_connection_id_connector_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connector_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_personal_accounts" ADD CONSTRAINT "connector_personal_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_personal_accounts_one_live" ON "connector_personal_accounts" USING btree ("connection_id","owner_user_id") WHERE "connector_personal_accounts"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "connector_personal_accounts_org_id_index" ON "connector_personal_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "connector_personal_accounts_composio_account_id_index" ON "connector_personal_accounts" USING btree ("composio_account_id");