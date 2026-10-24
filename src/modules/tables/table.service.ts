/**
 * table.service.ts — DB-backed table management operations.
 * Enforces branch isolation and state machine via table.engine.ts.
 */

import { db } from '../../db/client.js';
import { tables, tableSessions } from '../../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import {
  transitionTableStatus,
  validateStewardAssignment,
  type TableStatus,
} from './table.engine.js';

export interface OpenTableInput {
  tableId: string;
  branchId: string;
  stewardId?: string | null;
  guestCount?: number;
  notes?: string;
}

// ─── LIST TABLES ─────────────────────────────────────────────────────────────

export async function getTablesForBranch(branchId: string) {
  return db
    .select()
    .from(tables)
    .where(eq(tables.branchId, branchId))
    .orderBy(tables.name);
}

// ─── OPEN TABLE (start session) ───────────────────────────────────────────────

export async function openTable(input: OpenTableInput) {
  validateStewardAssignment(input.stewardId ?? null);

  return db.transaction(async (tx) => {
    // Lock and check current status
    const [table] = await tx
      .select({ id: tables.id, status: tables.status })
      .from(tables)
      .where(and(eq(tables.id, input.tableId), eq(tables.branchId, input.branchId)));

    if (!table) throw new Error(`Table ${input.tableId} not found in branch ${input.branchId}.`);

    const nextStatus = transitionTableStatus(table.status as TableStatus, 'open');

    // Update table status
    await tx
      .update(tables)
      .set({ status: nextStatus })
      .where(eq(tables.id, input.tableId));

    // Create session
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
    const [table] = await tx
      .select({ id: tables.id, status: tables.status })
      .from(tables)
      .where(and(eq(tables.id, tableId), eq(tables.branchId, branchId)));

    if (!table) throw new Error(`Table ${tableId} not found.`);

    const nextStatus = transitionTableStatus(table.status as TableStatus, 'close');

    await tx.update(tables).set({ status: nextStatus }).where(eq(tables.id, tableId));

    // Close the active session
    const [session] = await tx
      .update(tableSessions)
      .set({
        closedAt: new Date(),
        ...(billId ? { billId } : {}),
      })
      .where(and(
        eq(tableSessions.tableId, tableId),
        isNull(tableSessions.closedAt),
      ))
      .returning();

    return session;
  });
}

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────

export async function createTable(branchId: string, name: string, capacity = 4, section?: string) {
  const [table] = await db
    .insert(tables)
    .values({ branchId, name, capacity, section: section ?? null })
    .returning();
  return table;
}
