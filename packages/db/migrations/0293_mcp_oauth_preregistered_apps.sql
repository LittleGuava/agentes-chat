-- deploy-safe: the unique index comes back in this same migration, partial on "not preregistered"; the version before writes only such rows (the new column defaults to false) and its insert names no conflict target
DROP INDEX "oauth_clients_org_issuer";--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "preregistered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_org_issuer_app" ON "oauth_clients" USING btree ("org_id","issuer","client_id") WHERE "oauth_clients"."preregistered";--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_org_issuer" ON "oauth_clients" USING btree ("org_id","issuer") WHERE not "oauth_clients"."preregistered";