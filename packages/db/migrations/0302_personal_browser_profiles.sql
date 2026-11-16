-- deploy-safe: made again below, narrower (a person's own browser left out); the running version never writes such a row and its own name check still holds
DROP INDEX "browser_profiles_name";--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD COLUMN "person_user_id" text;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_person_user_id_users_id_fk" FOREIGN KEY ("person_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_profiles_personal" ON "browser_profiles" USING btree ("agent_id","person_user_id","machine_id") WHERE "browser_profiles"."deleted_at" is null and "browser_profiles"."person_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_profiles_name" ON "browser_profiles" USING btree ("org_id",lower("name")) WHERE "browser_profiles"."deleted_at" is null and "browser_profiles"."person_user_id" is null;