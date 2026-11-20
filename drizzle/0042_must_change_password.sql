-- A password an administrator chose (a reset) is known to someone else: the person must replace it before doing anything else.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
