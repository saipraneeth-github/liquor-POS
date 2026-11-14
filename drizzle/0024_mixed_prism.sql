ALTER TABLE "daily_counter_sheet_lines" ADD COLUMN "opening_system" integer;--> statement-breakpoint
ALTER TABLE "daily_counter_sheet_lines" ADD COLUMN "opening_edited_by_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheet_lines" ADD CONSTRAINT "daily_counter_sheet_lines_opening_edited_by_id_users_id_fk" FOREIGN KEY ("opening_edited_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
