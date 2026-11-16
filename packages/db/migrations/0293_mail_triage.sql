CREATE TABLE "mail_triage" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"message_key" text NOT NULL,
	"verdict" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_triage_account_id_message_key_pk" PRIMARY KEY("account_id","message_key")
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "triage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_triage" ADD CONSTRAINT "mail_triage_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_triage_org_id_index" ON "mail_triage" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mail_triage_judged_at_index" ON "mail_triage" USING btree ("judged_at");