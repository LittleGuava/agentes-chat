CREATE TABLE "announcement_dismissals" (
	"announcement_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_dismissals_user_id_announcement_id_pk" PRIMARY KEY("user_id","announcement_id")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link_url" text,
	"link_label" text,
	"audience" text NOT NULL,
	"org_id" uuid,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_audience" CHECK ("announcements"."audience" in ('everyone', 'admins', 'workspace')),
	CONSTRAINT "announcements_workspace" CHECK (("announcements"."audience" = 'workspace') = ("announcements"."org_id" is not null)),
	CONSTRAINT "announcements_period" CHECK ("announcements"."ends_at" is null or "announcements"."ends_at" > "announcements"."starts_at"),
	CONSTRAINT "announcements_link" CHECK ("announcements"."link_label" is null or "announcements"."link_url" is not null)
);
--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_dismissals_announcement_id_index" ON "announcement_dismissals" USING btree ("announcement_id");--> statement-breakpoint
CREATE INDEX "announcements_created" ON "announcements" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "announcements_org" ON "announcements" USING btree ("org_id");