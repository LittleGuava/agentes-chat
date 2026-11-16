ALTER TABLE "import_items" ADD COLUMN "written_hash" text;--> statement-breakpoint
ALTER TABLE "import_items" ADD COLUMN "undone_at" timestamp with time zone;