ALTER TABLE "syndicates" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "archive_reason" text;--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "exported_at" timestamp with time zone;