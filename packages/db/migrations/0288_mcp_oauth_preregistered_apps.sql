DROP INDEX "oauth_clients_org_issuer";--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "preregistered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_org_issuer_app" ON "oauth_clients" USING btree ("org_id","issuer","client_id") WHERE "oauth_clients"."preregistered";--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_org_issuer" ON "oauth_clients" USING btree ("org_id","issuer") WHERE not "oauth_clients"."preregistered";