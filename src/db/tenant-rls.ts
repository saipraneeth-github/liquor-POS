/**
 * tenant-rls.ts — binds a database transaction to one tenant.
 *
 * The quality tables are protected by Row-Level Security (migration 0029): every policy compares
 * `tenant_id` against `app_tenant_id()`, which reads the `app.tenant_id` setting. Wrapping the work
 * in `withTenant(...)` sets that setting for the life of the transaction, so:
 *
 *   • a query that forgets its own `WHERE tenant_id = ...` still cannot see another tenant's rows;
 *   • an INSERT that tries to forge another tenant's `tenant_id` is rejected by the WITH CHECK clause.
 *
 * `set_config(..., true)` is transaction-local, so the setting never leaks to the next request on a
 * pooled connection.
 *
 * NOTE: PGlite runs as the superuser `postgres`, and superusers bypass RLS even with FORCE. The
 * policies are therefore exercised for real on PostgreSQL; the service still filters by tenant
 * explicitly on every query, which is what the tests assert.
 */

import { sql } from 'drizzle-orm';
import { db } from './client.js';
import type { Tx } from '../lib/domain-events.js';

/** Runs `fn` inside a transaction scoped to one tenant. */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Runs `fn` with the platform (Super Admin) bypass on, for cross-tenant support work. */
export function withPlatformScope<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.platform_scope', 'on', true)`);
    return fn(tx);
  });
}

/** True when the connection would currently see every tenant (platform scope). */
export async function isPlatformScope(): Promise<boolean> {
  const [row] = (await db.execute(sql`select coalesce(current_setting('app.platform_scope', true), '') = 'on' as scope`)) as unknown as { scope: boolean }[];
  return row?.scope === true;
}