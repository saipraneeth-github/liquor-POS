CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"description" text,
	"level" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pages" jsonb,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "roles_key_unique" UNIQUE("key"),
	CONSTRAINT "roles_name_key_unique" UNIQUE("name_key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roles" ADD CONSTRAINT "roles_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "name_key", "description", "level", "permissions", "is_system") VALUES
	('owner', 'Owner / Admin', 'owner / admin', 'Runs the business. Has every permission and cannot be restricted.', 'owner', '[]'::jsonb, true),
	('office_admin', 'Office admin', 'office admin', 'Runs the business on the owner''s behalf. Has every permission and cannot be restricted.', 'office_admin', '[]'::jsonb, true),
	('manager', 'Manager', 'manager', 'Runs a shop. Has every action permission unless one is switched off for the person.', 'manager', '[]'::jsonb, true),
	('cashier', 'Cashier', 'cashier', 'Bills customers. Has no extra action permission unless one is given to the person.', 'cashier', '[]'::jsonb, true),
	('steward', 'Steward', 'steward', 'Serves tables. Has no extra action permission unless one is given to the person.', 'steward', '[]'::jsonb, true)
ON CONFLICT ("key") DO NOTHING;
