ALTER TABLE "organization_members" ADD COLUMN "active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "away_email_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "away_email_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "organization_members_away" ON "organization_members" USING btree ("active_at") WHERE "organization_members"."away_email_minutes" > 0;