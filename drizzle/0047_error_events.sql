-- Built-in error tracking: one row per distinct error (fingerprint), counted. No request bodies or headers are ever stored.
CREATE TABLE IF NOT EXISTS "error_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fingerprint" text NOT NULL,
  "source" text NOT NULL,
  "message" text NOT NULL,
  "stack" text,
  "route" text,
  "method" text,
  "status" integer,
  "user_id" uuid,
  "branch_id" uuid,
  "user_agent" text,
  "release" text,
  "occurrences" integer DEFAULT 1 NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by_id" uuid,
  CONSTRAINT "error_events_fingerprint_unique" UNIQUE ("fingerprint"),
  CONSTRAINT "ck_error_events_source" CHECK (source IN ('SERVER','BROWSER'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_error_events_last_seen" ON "error_events" ("last_seen_at");
