/**
 * tenant-lifecycle.service.ts — archive, restore, export and permanently delete a business.
 *
 *   Archive   blocks everyone, records why, hides the business from the active lists. Nothing is removed.
 *   Restore   undoes an archive.
 *   Export    everything the business owns, as JSON (its books are legal records: download before deleting).
 *   Delete    only after 30 days in the archive, with the exact business name typed, and no unpaid invoices.
 *             Removes every row the business owns in one transaction: any problem rolls all of it back.
 *
 * "Owns" is found by following foreign keys from the business downwards (business → branches / users / products /
 * invoices → bills → bill lines …). The keys are read from the database itself, so a table added later is covered
 * without touching this file. The audit trail is the one thing that points at a business's users and must survive:
 * its `actor_id` is cleared, its rows are kept.
 */
import { z } from 'zod';
import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { subscriptionInvoices, syndicates } from '../../db/schema.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
import type { Tx } from '../../lib/domain-events.js';

export const ARCHIVE_RETENTION_DAYS = 30;
const DAY = 86_400_000;

/**
 * How long a business must sit in the archive before it can be deleted. Always 30 days in production. Outside production
 * ARCHIVE_RETENTION_DAYS may shorten it (the browser tests use 0), so a live server can never be misconfigured into instant deletes.
 */
export function retentionDays(): number {
  const raw = Number(process.env.ARCHIVE_RETENTION_DAYS);
  if (process.env.NODE_ENV === 'production' || !Number.isInteger(raw) || raw < 0) return ARCHIVE_RETENTION_DAYS;
  return raw;
}

export const ArchiveSchema = z.object({ reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(300) });
export const DeleteSchema = z.object({ confirmName: z.string().max(300), acknowledge: z.literal(true) });

// ─── READING THE DATABASE'S OWN FOREIGN KEYS ────────────────────────────────

type Exec = Tx | typeof db;
type Fk = { child: string; childCol: string; parent: string; parentCol: string };
type Col = { name: string; type: string };

/** Tables that point at a business's rows but must outlive it: the pointer is cleared instead of the row deleted. */
const KEEP_ROWS = new Set(['audit_log']);
/** Never leave the database: secrets, and bulk binary data (scanned invoices). */
const HIDDEN_COLUMNS = new Set(['password_hash', 'token_hash']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 500;

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** A SQL uuid[] literal. Every id is checked first, so nothing but a well-formed uuid can reach the statement. */
const uuidArr = (ids: string[]) => `ARRAY[${ids.map((i) => { if (!UUID.test(i)) throw new Error('unexpected id'); return `'${i}'`; }).join(',')}]::uuid[]`;
const chunks = <T>(a: T[]) => Array.from({ length: Math.ceil(a.length / CHUNK) }, (_, i) => a.slice(i * CHUNK, (i + 1) * CHUNK));

async function loadSchemaInfo(exec: Exec): Promise<{ fks: Fk[]; cols: Map<string, Col[]> }> {
  const fks = rowsOf<Fk>(await exec.execute(sql`
    select (select relname from pg_class where oid = c.conrelid) as child, ca.attname as "childCol",
           (select relname from pg_class where oid = c.confrelid) as parent, pa.attname as "parentCol"
    from pg_constraint c
    join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1`));
  const colRows = rowsOf<{ table_name: string; column_name: string; data_type: string }>(await exec.execute(sql`
    select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`));
  const cols = new Map<string, Col[]>();
  for (const c of colRows) cols.set(c.table_name, [...(cols.get(c.table_name) ?? []), { name: c.column_name, type: c.data_type }]);
  return { fks, cols };
}

// ─── WHAT A BUSINESS OWNS ───────────────────────────────────────────────────

interface Owned {
  ids: Set<string>;                                   // rows of tables that have an `id`
  reach: Array<{ col: string; ids: string[] }>;       // how rows were found: used to delete tables that have no `id`
  rows: Record<string, unknown>[];                    // filled only when exporting
  count: number;                                      // rows, for tables without an `id` too
}

/** Walks down the foreign keys from the business. `withRows` also reads the rows (for the export). */
async function collectOwned(exec: Exec, syndicateId: string, withRows: boolean) {
  const { fks, cols } = await loadSchemaInfo(exec);
  const owned = new Map<string, Owned>();
  const get = (t: string): Owned => { let o = owned.get(t); if (!o) { o = { ids: new Set(), reach: [], rows: [], count: 0 }; owned.set(t, o); } return o; };
  get('syndicates').ids.add(syndicateId);
  if (withRows) {
    const [row] = rowsOf<Record<string, unknown>>(await exec.execute(sql`select * from syndicates where id = ${syndicateId}`));
    get('syndicates').rows.push(row);
  }
  get('syndicates').count = 1;
  const keepFks = fks.filter((f) => KEEP_ROWS.has(f.child));

  const queue: Array<{ table: string; ids: string[] }> = [{ table: 'syndicates', ids: [syndicateId] }];
  while (queue.length) {
    const { table, ids } = queue.shift()!;
    for (const fk of fks.filter((f) => f.parent === table && f.parentCol === 'id' && !KEEP_ROWS.has(f.child))) {
      const childCols = cols.get(fk.child) ?? [];
      const hasId = childCols.some((c) => c.name === 'id');
      const select = withRows
        ? childCols.filter((c) => c.type !== 'bytea' && !HIDDEN_COLUMNS.has(c.name)).map((c) => q(c.name)).join(', ')
        : hasId ? '"id"' : '1 as "one"';
      const found: Record<string, unknown>[] = [];
      for (const part of chunks(ids)) {
        found.push(...rowsOf<Record<string, unknown>>(await exec.execute(sql.raw(`select ${select} from ${q(fk.child)} where ${q(fk.childCol)} = any(${uuidArr(part)})`))));
      }
      if (found.length === 0) continue;
      const o = get(fk.child);
      const fresh: string[] = [];
      for (const r of found) {
        const id = hasId ? String(r.id) : null;
        if (id !== null) { if (o.ids.has(id)) continue; o.ids.add(id); fresh.push(id); }
        o.count++;
        if (withRows) o.rows.push(r);
      }
      o.reach.push({ col: fk.childCol, ids: ids.slice() });
      if (fresh.length) queue.push({ table: fk.child, ids: fresh });
    }
  }
  return { owned, fks, keepFks, cols };
}

/** Child tables before the tables they point at. */
function deletionOrder(tables: string[], fks: Fk[]): string[] {
  const set = new Set(tables);
  const dependsOn = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));   // t must be deleted AFTER these (its children)
  for (const f of fks) if (set.has(f.child) && set.has(f.parent) && f.child !== f.parent) dependsOn.get(f.parent)!.add(f.child);
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tables.length) {
    const ready = tables.filter((t) => !done.has(t) && [...dependsOn.get(t)!].every((c) => done.has(c)));
    if (ready.length === 0) throw new BusinessRuleError('The deletion order could not be worked out (circular references). Nothing was deleted.');
    for (const t of ready) { done.add(t); order.push(t); }
  }
  return order;
}

// ─── ARCHIVE / RESTORE ──────────────────────────────────────────────────────

async function loadTenant(id: string) {
  const [t] = await db.select().from(syndicates).where(eq(syndicates.id, id)).limit(1);
  if (!t) throw new NotFoundError('Tenant not found');
  return t;
}

/** Blocks the business and hides it from the active lists. Everything is kept; it can be restored until it is deleted. */
export async function archiveTenant(actorId: string | null, id: string, reason: string) {
  const t = await loadTenant(id);
  if (t.archivedAt) throw new ConflictError('This business is already archived');
  const now = new Date();
  await db.update(syndicates).set({ archivedAt: now, archiveReason: reason, isActive: false, nextPlan: null, nextPlanFrom: null }).where(eq(syndicates.id, id));
  await logAudit(actorId, 'tenant.archive', { type: 'tenant', id }, {
    reason, before: { isActive: t.isActive, archivedAt: null }, after: { isActive: false, archivedAt: now.toISOString() }, deletableFrom: new Date(now.getTime() + retentionDays() * DAY).toISOString(),
  });
  return { archivedAt: now, deletableFrom: new Date(now.getTime() + retentionDays() * DAY) };
}

export async function restoreTenant(actorId: string | null, id: string) {
  const t = await loadTenant(id);
  if (!t.archivedAt) throw new BusinessRuleError('This business is not archived');
  await db.update(syndicates).set({ archivedAt: null, archiveReason: null, isActive: true }).where(eq(syndicates.id, id));
  await logAudit(actorId, 'tenant.restore', { type: 'tenant', id }, { before: { isActive: false, archivedAt: t.archivedAt.toISOString() }, after: { isActive: true, archivedAt: null } });
  return { restored: true };
}

// ─── EXPORT ─────────────────────────────────────────────────────────────────

/** Every row the business owns, table by table (no password hashes, no scanned-file data). Marks the business as exported. */
export async function exportTenant(actorId: string | null, id: string) {
  const t = await loadTenant(id);
  const { owned } = await collectOwned(db, id, true);
  const tables = Object.fromEntries([...owned.entries()].map(([name, o]) => [name, o.rows]));
  const total = [...owned.values()].reduce((s, o) => s + o.count, 0);
  const now = new Date();
  await db.update(syndicates).set({ exportedAt: now }).where(eq(syndicates.id, id));
  await logAudit(actorId, 'tenant.export', { type: 'tenant', id }, { rows: total, tables: Object.keys(tables).length });
  return { exportedAt: now.toISOString(), business: t.name, note: 'Password hashes and scanned invoice files are not included.', rowCount: total, tables };
}

// ─── DELETE ─────────────────────────────────────────────────────────────────

async function unpaid(id: string) {
  const [r] = await db.select({ n: count(), amount: sql<string>`coalesce(sum(${subscriptionInvoices.amount}), 0)::numeric(14,2)::text` }).from(subscriptionInvoices)
    .where(and(eq(subscriptionInvoices.syndicateId, id), eq(subscriptionInvoices.status, 'PENDING')));
  return { count: Number(r.n), amount: r.amount };
}

/** What deleting would remove, and whether (and when) it is allowed. Changes nothing. */
export async function deletePreview(id: string) {
  const t = await loadTenant(id);
  const { owned } = await collectOwned(db, id, false);
  const tables = [...owned.entries()].map(([table, o]) => ({ table, rows: o.count })).filter((x) => x.rows > 0).sort((a, b) => b.rows - a.rows);
  const eligibleFrom = t.archivedAt ? new Date(t.archivedAt.getTime() + retentionDays() * DAY) : null;
  const daysLeft = eligibleFrom ? Math.max(0, Math.ceil((eligibleFrom.getTime() - Date.now()) / DAY)) : null;
  const inv = await unpaid(id);
  return {
    name: t.name, archived: !!t.archivedAt, archivedAt: t.archivedAt, archiveReason: t.archiveReason, eligibleFrom, daysLeft,
    eligible: !!t.archivedAt && daysLeft === 0, unpaidInvoices: inv, exportedAt: t.exportedAt,
    totalRows: tables.reduce((s, x) => s + x.rows, 0), tables,
  };
}

/**
 * Permanently removes the business and everything it owns. Refused unless it has been archived for 30 days, has no unpaid
 * invoice, and the caller typed the business name exactly. All-or-nothing.
 */
export async function deleteTenant(actorId: string | null, id: string, confirmName: string) {
  const t = await loadTenant(id);
  if (!t.archivedAt) throw new BusinessRuleError('Archive the business first. It can only be deleted after 30 days in the archive.');
  const eligibleFrom = new Date(t.archivedAt.getTime() + retentionDays() * DAY);
  if (eligibleFrom.getTime() > Date.now()) {
    const left = Math.ceil((eligibleFrom.getTime() - Date.now()) / DAY);
    throw new BusinessRuleError(`Too soon: it can be deleted from ${eligibleFrom.toISOString().slice(0, 10)} (${left} more day${left === 1 ? '' : 's'}).`);
  }
  const inv = await unpaid(id);
  if (inv.count > 0) throw new BusinessRuleError(`Tenant has unpaid invoices (${inv.count}, ₹${inv.amount}). Void or settle them first.`);
  if (confirmName.trim() !== t.name.trim()) throw new BusinessRuleError('The name you typed does not match the business name.');

  const summary: Record<string, number> = {};
  await db.transaction(async (tx) => {
    const { owned, fks, keepFks } = await collectOwned(tx, id, false);
    // The audit trail stays; it just stops pointing at people who no longer exist
    for (const fk of keepFks) {
      const ids = [...(owned.get(fk.parent)?.ids ?? [])];
      for (const part of chunks(ids)) {
        await tx.execute(sql.raw(`update ${q(fk.child)} set ${q(fk.childCol)} = null where ${q(fk.childCol)} = any(${uuidArr(part)})`));
      }
    }
    // Self-references (a branch under a branch) are cleared first, so rows can be removed together
    for (const fk of fks.filter((f) => f.child === f.parent && owned.has(f.child))) {
      for (const part of chunks([...owned.get(fk.child)!.ids])) {
        await tx.execute(sql.raw(`update ${q(fk.child)} set ${q(fk.childCol)} = null where "id" = any(${uuidArr(part)})`));
      }
    }
    for (const table of deletionOrder([...owned.keys()], fks)) {
      const o = owned.get(table)!;
      if (o.ids.size > 0) {
        for (const part of chunks([...o.ids])) await tx.execute(sql.raw(`delete from ${q(table)} where "id" = any(${uuidArr(part)})`));
      } else {
        for (const r of o.reach) for (const part of chunks(r.ids)) await tx.execute(sql.raw(`delete from ${q(table)} where ${q(r.col)} = any(${uuidArr(part)})`));
      }
      if (o.count > 0) summary[table] = o.count;
    }
  });
  await logAudit(actorId, 'tenant.delete', { type: 'tenant', id }, {
    name: t.name, archivedAt: t.archivedAt.toISOString(), archiveReason: t.archiveReason, exportedBeforeDelete: !!t.exportedAt,
    rows: Object.values(summary).reduce((s, n) => s + n, 0), tables: summary,
  });
  return { deleted: true, name: t.name, rows: Object.values(summary).reduce((s, n) => s + n, 0), tables: summary };
}

// ─── UNPAID INVOICES ────────────────────────────────────────────────────────

/** Cancels an unpaid subscription invoice (for example before deleting a business that never paid it). */
export async function voidInvoice(actorId: string | null, invoiceId: string) {
  const [inv] = await db.update(subscriptionInvoices).set({ status: 'VOID' })
    .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.status, 'PENDING'))).returning();
  if (!inv) throw new BusinessRuleError('Invoice not found or already settled');
  await logAudit(actorId, 'invoice.void', { type: 'tenant', id: inv.syndicateId }, { invoiceId, amount: inv.amount, plan: inv.plan });
  return inv;
}
