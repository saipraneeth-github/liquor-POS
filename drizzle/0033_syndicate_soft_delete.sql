ALTER TABLE "syndicates" ADD COLUMN "is_deleted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Businesses already archived are the soft-deleted ones
UPDATE "syndicates" SET "is_deleted" = true WHERE "archived_at" IS NOT NULL;
