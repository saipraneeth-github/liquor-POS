import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from './client.js';

/**
 * Migrations in ./drizzle that the connected database has not applied yet. Drizzle records each applied migration with the
 * journal's `when` timestamp and applies, in order, everything newer than the latest one, so "pending" = entries newer than
 * the latest recorded. A database that was never migrated has no record table: everything is pending.
 */
export async function pendingMigrations(): Promise<string[]> {
  const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as { entries: { tag: string; when: number }[] };
  let last = -1;
  try {
    const result = (await db.execute(sql`select max(created_at)::bigint::text as last from drizzle.__drizzle_migrations`)) as unknown;
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as { last: string | null }[];
    if (rows[0]?.last != null) last = Number(rows[0].last);
  } catch {
    // drizzle.__drizzle_migrations does not exist yet
  }
  return journal.entries.filter((e) => e.when > last).map((e) => e.tag);
}
