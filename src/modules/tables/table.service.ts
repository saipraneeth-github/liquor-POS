/**
 * table.service.ts — DB-backed table management operations.
 * Enforces branch isolation and state machine via table.engine.ts.
 */

import { db } from '../../db/client.js';
import { tables, tableSessions, users, bills } from '../../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import {
  transitionTableStatus,
  validateStewardAssignment,
  type TableStatus,
} from './table.engine.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';

export interface OpenTableInput {
  tableId: string;
  branchId: string;
  stewardId?: string | null;
  guestCount?: number;
  notes?: string;
}

// ─── LIST TABLES ─────────────────────────────────────────────────────────────

/**
 * Tables of a branch, each with its open session (if any) so clients can raise KOTs and bill
 * an occupied table without having opened it themselves.
 */
export async function getTablesForBranch(branchId: string) {
  const [rows, openSessions] = await Promise.all([
    db.select().from(tables).where(eq(tables.branchId, branchId)).orderBy(tables.name),
    db
      .select({
        id:         tableSessions.id,
        tableId:    tableSessions.tableId,
        openedAt:   tableSessions.openedAt,
        guestCount: tableSessions.guestCount,
        stewardId:  tableSessions.stewardId,
      })
      .from(tableSessions)
      .where(and(eq(tableSessions.branchId, branchId), isNull(tableSessions.closedAt))),
  ]);
  // Latest open session per table (there should only ever be one)
  const byTable = new Map<string, (typeof openSessions)[number]>();
  for (const s of openSessions) {
    const prev = byTable.get(s.tableId);
    if (!prev || (s.openedAt?.getTime() ?? 0) > (prev.openedAt?.getTime() ?? 0)) byTable.set(s.tableId, s);
  }
  return rows.map((t) => {
    const s = byTable.get(t.id);
    return {
      ...t,
      currentSessionId:  s?.id ?? null,
      sessionOpenedAt:   s?.openedAt ?? null,
      sessionGuestCount: s?.guestCount ?? null,
      sessionStewardId:  s?.stewardId ?? null,
    };
  });
}

// ─── OPEN TABLE (start session) ───────────────────────────────────────────────

export async function openTable(input: OpenTableInput) {
  validateStewardAssignment(input.stewardId ?? null);

  return db.transaction(async (tx) => {
    if (input.stewardId) {
      const [steward] = await tx
        .select({ id: users.id, branchId: users.branchId, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, input.stewardId))
        .limit(1);
      if (!steward || steward.branchId !== input.branchId || !steward.isActive) {
        throw new BusinessRuleError('Steward not found in this branch');
      }
    }

    const [table] = await tx
      .select({ id: tables.id, status: tables.status })
      .from(tables)
      .where(and(eq(tables.id, input.tableId), eq(tables.branchId, input.branchId)))
      .for('update');

    if (!table) throw new NotFoundError('Table not found in this branch');

    let nextStatus: TableStatus;
    try {
      nextStatus = transitionTableStatus(table.status as TableStatus, 'open');
    } catch (err) {
      throw new ConflictError(err instanceof Error ? err.message : 'Table cannot be opened');
    }

    // Conditional update: only succeeds if nobody changed the status meanwhile
    const updated = await tx
      .update(tables)
      .set({ status: nextStatus })
      .where(and(eq(tables.id, input.tableId), eq(tables.status, table.status)))
      .returning({ id: tables.id });
    if (updated.length === 0) throw new ConflictError('Table status changed concurrently; retry');

    const [session] = await tx
      .insert(tableSessions)
      .values({
        tableId:    input.tableId,
        branchId:   input.branchId,
        stewardId:  input.stewardId ?? null,
        guestCount: input.guestCount ?? null,
        notes:      input.notes ?? null,
      })
      .returning();

    return session;
  });
}

// ─── CLOSE TABLE (end session) ────────────────────────────────────────────────

export async function closeTable(tableId: string, branchId: string, billId?: string) {
  return db.transaction(async (tx) => {
    if (billId) {
      const [bill] = await tx
        .select({ id: bills.id, branchId: bills.branchId })
        .from(bills)
        .where(eq(bills.id, billId))
        .limit(1);
      if (!bill || bill.branchId !== branchId) throw new BusinessRuleError('Bill not found in this branch');
    }

    const [table] = await tx
      .select({ id: tables.id, status: tables.status })
      .from(tables)
      .where(and(eq(tables.id, tableId), eq(tables.branchId, branchId)))
      .for('update');

    if (!table) throw new NotFoundError('Table not found in this branch');

    let nextStatus: TableStatus;
    try {
      nextStatus = transitionTableStatus(table.status as TableStatus, 'close');
    } catch (err) {
      throw new ConflictError(err instanceof Error ? err.message : 'Table cannot be closed');
    }

    const updated = await tx
      .update(tables)
      .set({ status: nextStatus })
      .where(and(eq(tables.id, tableId), eq(tables.status, table.status)))
      .returning({ id: tables.id });
    if (updated.length === 0) throw new ConflictError('Table status changed concurrently; retry');

    // Close the active session
    const [session] = await tx
      .update(tableSessions)
      .set({
        closedAt: new Date(),
        ...(billId ? { billId } : {}),
      })
      .where(and(
        eq(tableSessions.tableId, tableId),
        eq(tableSessions.branchId, branchId),
        isNull(tableSessions.closedAt),
      ))
      .returning();

    return session ?? null;
  });
}

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────

export async function createTable(branchId: string, name: string, capacity = 4, section?: string) {
  const [table] = await db
    .insert(tables)
    .values({ branchId, name: name.trim(), capacity, section: section ?? null })
    .returning();
  return table;
}
