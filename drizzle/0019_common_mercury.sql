CREATE TABLE IF NOT EXISTS "saas_plans" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"cycle_days" integer DEFAULT 30 NOT NULL,
	"max_branches" integer NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "next_plan" text;--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "next_plan_from" date;--> statement-breakpoint
INSERT INTO "saas_plans" ("code", "name", "price", "cycle_days", "max_branches", "features", "sort_order") VALUES
	('TRIAL', 'Trial', '0.00', 30, 1, '["14-day free trial","1 branch"]'::jsonb, 10),
	('STANDARD', 'Standard', '2999.00', 30, 3, '["Up to 3 branches","Billing, stock, accounting and bank reconciliation"]'::jsonb, 20),
	('PRO', 'Pro', '7999.00', 30, 25, '["Up to 25 branches","Everything in Standard"]'::jsonb, 30)
ON CONFLICT ("code") DO NOTHING;
