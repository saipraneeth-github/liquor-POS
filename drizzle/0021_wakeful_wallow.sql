CREATE TABLE IF NOT EXISTS "branch_features" (
	"branch_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "branch_features_branch_id_feature_pk" PRIMARY KEY("branch_id","feature")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_features" ADD CONSTRAINT "branch_features_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_features" ADD CONSTRAINT "branch_features_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
