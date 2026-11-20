-- ─── Row-Level Security for the quality (flaw) tables ───────────────────────
-- Multi-tenant isolation. Every quality row belongs to one business (tenant_id = syndicates.id).
-- The service filters by tenant explicitly AND runs inside a transaction that has set app.tenant_id
-- (src/db/tenant-rls.ts); RLS is the backstop, so a query that forgets the filter returns zero rows
-- instead of another tenant's defects. FORCE makes the policies apply to the table owner too.
--
-- Platform (Super Admin) access sets app.platform_scope = 'on' and bypasses the tenant check.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_platform_scope() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(current_setting('app.platform_scope', true), '') = 'on'
$$;
--> statement-breakpoint
ALTER TABLE "quality_modules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quality_modules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "quality_modules_tenant_isolation" ON "quality_modules";--> statement-breakpoint
CREATE POLICY "quality_modules_tenant_isolation" ON "quality_modules" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaws" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaws" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaws_tenant_isolation" ON "flaws";--> statement-breakpoint
CREATE POLICY "flaws_tenant_isolation" ON "flaws" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaw_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_comments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_comments_tenant_isolation" ON "flaw_comments";--> statement-breakpoint
CREATE POLICY "flaw_comments_tenant_isolation" ON "flaw_comments" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaw_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_attachments_tenant_isolation" ON "flaw_attachments";--> statement-breakpoint
CREATE POLICY "flaw_attachments_tenant_isolation" ON "flaw_attachments" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaw_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_tags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_tags_tenant_isolation" ON "flaw_tags";--> statement-breakpoint
CREATE POLICY "flaw_tags_tenant_isolation" ON "flaw_tags" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaw_duplicates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_duplicates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_duplicates_tenant_isolation" ON "flaw_duplicates";--> statement-breakpoint
CREATE POLICY "flaw_duplicates_tenant_isolation" ON "flaw_duplicates" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaw_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_history_tenant_isolation" ON "flaw_history";--> statement-breakpoint
CREATE POLICY "flaw_history_tenant_isolation" ON "flaw_history" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaw_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_links_tenant_isolation" ON "flaw_links";--> statement-breakpoint
CREATE POLICY "flaw_links_tenant_isolation" ON "flaw_links" USING (tenant_id = app_tenant_id() OR app_platform_scope()) WITH CHECK (tenant_id = app_tenant_id() OR app_platform_scope());--> statement-breakpoint
ALTER TABLE "flaw_tag_map" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_tag_map" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_tag_map_tenant_isolation" ON "flaw_tag_map";--> statement-breakpoint
CREATE POLICY "flaw_tag_map_tenant_isolation" ON "flaw_tag_map" USING (EXISTS (SELECT 1 FROM flaws f WHERE f.id = flaw_tag_map.flaw_id AND (f.tenant_id = app_tenant_id() OR app_platform_scope()))) WITH CHECK (EXISTS (SELECT 1 FROM flaws f WHERE f.id = flaw_tag_map.flaw_id AND (f.tenant_id = app_tenant_id() OR app_platform_scope())));--> statement-breakpoint
ALTER TABLE "flaw_watchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flaw_watchers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "flaw_watchers_tenant_isolation" ON "flaw_watchers";--> statement-breakpoint
CREATE POLICY "flaw_watchers_tenant_isolation" ON "flaw_watchers" USING (EXISTS (SELECT 1 FROM flaws f WHERE f.id = flaw_watchers.flaw_id AND (f.tenant_id = app_tenant_id() OR app_platform_scope()))) WITH CHECK (EXISTS (SELECT 1 FROM flaws f WHERE f.id = flaw_watchers.flaw_id AND (f.tenant_id = app_tenant_id() OR app_platform_scope())));