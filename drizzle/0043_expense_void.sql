-- An expense is never deleted: it is voided (reason required) and a reversing voucher is posted, like a bill.
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "voided_by_id" uuid;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "void_reason" text;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_id_users_id_fk" FOREIGN KEY ("voided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
