-- A password change or reset must end every session signed in before it: tokens older than this moment are refused
-- (requireRole already re-reads the user on each request, so the check costs no extra query).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp with time zone;
