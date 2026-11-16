CREATE TABLE "conversation_models" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"brain" text NOT NULL,
	"model" text NOT NULL,
	"set_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_models_agent_id_conversation_id_pk" PRIMARY KEY("agent_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_models" ADD CONSTRAINT "conversation_models_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_models" ADD CONSTRAINT "conversation_models_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_models" ADD CONSTRAINT "conversation_models_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_models_org_id_channel_id_index" ON "conversation_models" USING btree ("org_id","channel_id");