/**
 * table.service.ts — DB-backed table management operations.
 * Enforces branch isolation and state machine via table.engine.ts.
 */

import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import { tables, tableSessions, users, bills, billItems, kotOrders, kotItems, products, productServings } from '../../db/schema.js';
import { eq, and, isNull, inArray, sql, gte, lt, desc, or } from 'drizzle-orm';
import { logAudit } from '../../lib/audit.js';
import { businessDateOf, businessDayBounds, isIsoDate } from '../../lib/business-day.js';
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
    const sTime = s.openedAt instanceof Date ? s.openedAt.getTime() : new Date(s.openedAt ?? 0).getTime();
    const prevTime = prev?.openedAt instanceof Date ? prev.openedAt.getTime() : new Date(prev?.openedAt ?? 0).getTime();
    if (!prev || sTime > prevTime) byTable.set(s.tableId, s);
  }

  // What each open table has ordered so far, so the floor can see the bill without opening the table. Prices are MRP (tax
  // included), exactly what the table's bill will add up to before any discount. Cancelled items and orders do not count.
  const sessionIds = [...byTable.values()].map((s) => s.id);
  const totals = sessionIds.length === 0 ? [] : await db
    .select({
      sessionId: kotOrders.tableSessionId,
      total: sql<string>`coalesce(sum(case when ${kotItems.status} <> 'CANCELLED' then ${kotItems.quantity} * ${kotItems.unitPrice} end), 0)::numeric(14,2)::text`,
      items: sql<number>`coalesce(sum(case when ${kotItems.status} <> 'CANCELLED' then ${kotItems.quantity} end), 0)::int`,
      toServe: sql<number>`coalesce(sum(case when ${kotItems.status} in ('PENDING', 'PREPARING') then ${kotItems.quantity} end), 0)::int`,
      lastOrderAt: sql<string | null>`max(${kotOrders.createdAt})`,
    })
    .from(kotOrders)
    .innerJoin(kotItems, eq(kotItems.kotOrderId, kotOrders.id))
    .where(and(inArray(kotOrders.tableSessionId, sessionIds), sql`${kotOrders.status} <> 'CANCELLED'`))
    .groupBy(kotOrders.tableSessionId);
  const bySession = new Map(totals.map((x) => [x.sessionId, x]));

  const stewardIds = [...new Set([...byTable.values()].map((s) => s.stewardId).filter((x): x is string => !!x))];
  const stewards = stewardIds.length === 0 ? [] : await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, stewardIds));
  const stewardName = new Map(stewards.map((u) => [u.id, u.name]));

  return rows.map((t) => {
    const s = byTable.get(t.id);
    const a = s ? bySession.get(s.id) : undefined;
    return {
      ...t,
      currentSessionId:  s?.id ?? null,
      sessionOpenedAt:   s?.openedAt ?? null,
      sessionGuestCount: s?.guestCount ?? null,
      sessionStewardId:  s?.stewardId ?? null,
      sessionStewardName: s?.stewardId ? stewardName.get(s.stewardId) ?? null : null,
      sessionTotal:       s ? (a?.total ?? '0.00') : null,        // spent so far
      sessionItems:       s ? (a?.items ?? 0) : null,             // items ordered
      sessionToServe:     s ? (a?.toServe ?? 0) : null,           // ordered but not served yet
      sessionLastOrderAt: a?.lastOrderAt ?? null,
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

// ─── MOVE / MERGE ─────────────────────────────────────────────────────────────

/** Lock two tables of a branch in a fixed order (no deadlock between two people moving at once). */
async function lockPair(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], branchId: string, a: string, b: string) {
  const [first, second] = [a, b].sort();
  const rows = [];
  for (const id of [first, second]) {
    const [t] = await tx.select({ id: tables.id, name: tables.name, status: tables.status }).from(tables)
      .where(and(eq(tables.id, id), eq(tables.branchId, branchId))).for('update');
    if (!t) throw new NotFoundError('Table not found in this branch');
    rows.push(t);
  }
  const byId = new Map(rows.map((t) => [t.id, t]));
  return { from: byId.get(a)!, to: byId.get(b)! };
}

async function openSessionOf(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tableId: string) {
  const [s] = await tx.select().from(tableSessions).where(and(eq(tableSessions.tableId, tableId), isNull(tableSessions.closedAt))).limit(1);
  return s ?? null;
}

/** Move a party (and everything they have ordered) to a free table. */
export async function moveTable(tableId: string, toTableId: string, branchId: string, actorId: string | null) {
  if (tableId === toTableId) throw new BusinessRuleError('Choose a different table');
  const result = await db.transaction(async (tx) => {
    const { from, to } = await lockPair(tx, branchId, tableId, toTableId);
    if (from.status !== 'OCCUPIED') throw new ConflictError(`${from.name} is not occupied`);
    if (to.status !== 'FREE') throw new ConflictError(`${to.name} is not free: choose a free table, or merge the two`);
    const session = await openSessionOf(tx, from.id);
    if (!session) throw new ConflictError(`${from.name} has no open order`);

    await tx.update(tableSessions).set({ tableId: to.id }).where(eq(tableSessions.id, session.id));
    await tx.update(tables).set({ status: 'FREE' }).where(eq(tables.id, from.id));
    await tx.update(tables).set({ status: 'OCCUPIED' }).where(eq(tables.id, to.id));
    return { session: { ...session, tableId: to.id }, from: from.name, to: to.name };
  });
  // after the commit: the audit log writes on its own connection, which would wait for this transaction
  await logAudit(actorId, 'table.move', { type: 'table_session', id: result.session.id }, { from: result.from, to: result.to, branchId });
  return result;
}

/** Put two occupied tables' orders on one bill: everything moves to `intoTableId`, and `tableId` becomes free. */
export async function mergeTables(tableId: string, intoTableId: string, branchId: string, actorId: string | null) {
  if (tableId === intoTableId) throw new BusinessRuleError('Choose a different table');
  const result = await db.transaction(async (tx) => {
    const { from, to } = await lockPair(tx, branchId, tableId, intoTableId);
    if (from.status !== 'OCCUPIED') throw new ConflictError(`${from.name} is not occupied`);
    if (to.status !== 'OCCUPIED') throw new ConflictError(`${to.name} is not occupied: move the party there instead`);
    const a = await openSessionOf(tx, from.id);
    const b = await openSessionOf(tx, to.id);
    if (!a || !b) throw new ConflictError('Both tables need an open order to be merged');

    const moved = await tx.update(kotOrders).set({ tableSessionId: b.id, updatedAt: new Date() }).where(eq(kotOrders.tableSessionId, a.id)).returning({ id: kotOrders.id });
    const guests = (a.guestCount ?? 0) + (b.guestCount ?? 0);
    await tx.update(tableSessions).set({ ...(guests > 0 ? { guestCount: guests } : {}), notes: [b.notes, `Merged with ${from.name}`].filter(Boolean).join(' · ') }).where(eq(tableSessions.id, b.id));
    await tx.update(tableSessions).set({ closedAt: new Date(), notes: [a.notes, `Merged into ${to.name}`].filter(Boolean).join(' · ') }).where(eq(tableSessions.id, a.id));
    await tx.update(tables).set({ status: 'FREE' }).where(eq(tables.id, from.id));
    return { session: { ...b, guestCount: guests > 0 ? guests : b.guestCount }, from: from.name, into: to.name, ordersMoved: moved.length };
  });
  await logAudit(actorId, 'table.merge', { type: 'table_session', id: result.session.id }, { from: result.from, into: result.into, orders: result.ordersMoved, branchId });
  return result;
}

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────

export async function createTable(branchId: string, name: string, capacity = 4, section?: string) {
  const [table] = await db
    .insert(tables)
    .values({ branchId, name: name.trim(), capacity, section: section ?? null })
    .returning();
  return table;
}

// ─── TODAY'S TABLE COLLECTION & BILLS ─────────────────────────────────────────

export async function getTableBillsAndCollectionToday(branchId: string, date?: string) {
  const targetDate = date && isIsoDate(date) ? date : businessDateOf();
  const { start, end } = businessDayBounds(targetDate);

  const rows = await db
    .select({
      billId: bills.id,
      billNumber: bills.billNumber,
      total: bills.total,
      subtotal: bills.subtotal,
      taxAmount: bills.taxAmount,
      discount: bills.discount,
      paymentMode: bills.paymentMode,
      status: bills.status,
      createdAt: bills.createdAt,
      tableId: tables.id,
      tableName: tables.name,
      section: tables.section,
      stewardId: tableSessions.stewardId,
      stewardName: users.name,
      guestCount: tableSessions.guestCount,
      sessionId: tableSessions.id,
    })
    .from(bills)
    .innerJoin(
      tableSessions,
      or(
        eq(tableSessions.billId, bills.id),
        sql`${bills.clientRef} = 'table-session:' || ${tableSessions.id}::text`
      )
    )
    .innerJoin(tables, eq(tableSessions.tableId, tables.id))
    .leftJoin(users, eq(tableSessions.stewardId, users.id))
    .where(and(
      eq(bills.branchId, branchId),
      gte(bills.createdAt, start),
      lt(bills.createdAt, end),
    ))
    .orderBy(desc(bills.createdAt), desc(bills.billNumber));

  // Deduplicate by billId in case of multiple join links
  const uniqueBills = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!uniqueBills.has(r.billId)) {
      uniqueBills.set(r.billId, r);
    }
  }
  const dedupedRows = [...uniqueBills.values()];

  const billIds = dedupedRows.map((r) => r.billId);
  const items = billIds.length === 0 ? [] : await db
    .select({
      billId: billItems.billId,
      productId: billItems.productId,
      productName: products.name,
      servingLabel: productServings.label,
      quantity: billItems.quantity,
      unitPrice: billItems.unitPrice,
      lineTotal: billItems.lineTotal,
    })
    .from(billItems)
    .innerJoin(products, eq(billItems.productId, products.id))
    .leftJoin(productServings, eq(billItems.servingId, productServings.id))
    .where(inArray(billItems.billId, billIds));

  const itemsByBill = new Map<string, typeof items>();
  for (const it of items) {
    const arr = itemsByBill.get(it.billId) ?? [];
    arr.push(it);
    itemsByBill.set(it.billId, arr);
  }

  let total = new Decimal(0);
  let cash = new Decimal(0);
  let card = new Decimal(0);
  let upi = new Decimal(0);
  let credit = new Decimal(0);
  let billCount = 0;
  let voidCount = 0;
  let guestCount = 0;

  const sectionTotals = new Map<string, { total: Decimal; count: number }>();
  const paymentModeCounts = new Map<string, { total: Decimal; count: number }>();

  for (const b of dedupedRows) {
    if (b.status === 'VOIDED') {
      voidCount++;
      continue;
    }
    const billTotal = new Decimal(b.total || '0');
    total = total.plus(billTotal);
    billCount++;
    guestCount += Number(b.guestCount || 0);

    const mode = b.paymentMode ?? 'CASH';
    if (mode === 'CASH') cash = cash.plus(billTotal);
    else if (mode === 'CARD') card = card.plus(billTotal);
    else if (mode === 'UPI') upi = upi.plus(billTotal);
    else if (mode === 'CREDIT') credit = credit.plus(billTotal);

    const modeEntry = paymentModeCounts.get(mode) ?? { total: new Decimal(0), count: 0 };
    modeEntry.total = modeEntry.total.plus(billTotal);
    modeEntry.count++;
    paymentModeCounts.set(mode, modeEntry);

    const secName = b.section?.trim() || 'General';
    const secEntry = sectionTotals.get(secName) ?? { total: new Decimal(0), count: 0 };
    secEntry.total = secEntry.total.plus(billTotal);
    secEntry.count++;
    sectionTotals.set(secName, secEntry);
  }

  const averageBill = billCount > 0 ? total.dividedBy(billCount).toFixed(2) : '0.00';

  const bySection = [...sectionTotals.entries()].map(([sec, val]) => ({
    section: sec,
    total: val.total.toFixed(2),
    billCount: val.count,
  }));

  const byPaymentMode = [...paymentModeCounts.entries()].map(([mode, val]) => ({
    mode,
    total: val.total.toFixed(2),
    count: val.count,
  }));

  const billsResult = dedupedRows.map((b) => {
    const lineItems = itemsByBill.get(b.billId) ?? [];
    return {
      id: b.billId,
      billNumber: b.billNumber,
      tableId: b.tableId,
      tableName: b.tableName,
      section: b.section,
      stewardId: b.stewardId,
      stewardName: b.stewardName,
      guestCount: b.guestCount,
      paymentMode: b.paymentMode,
      status: b.status,
      subtotal: b.subtotal,
      taxAmount: b.taxAmount,
      discount: b.discount,
      total: b.total,
      createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt),
      itemCount: lineItems.reduce((acc, it) => acc + it.quantity, 0),
      items: lineItems.map((it) => ({
        productName: it.productName,
        servingLabel: it.servingLabel,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal: it.lineTotal,
      })),
    };
  });

  return {
    date: targetDate,
    collection: {
      total: total.toFixed(2),
      cash: cash.toFixed(2),
      card: card.toFixed(2),
      upi: upi.toFixed(2),
      credit: credit.toFixed(2),
      billCount,
      voidCount,
      guestCount,
      averageBill,
      bySection,
      byPaymentMode,
    },
    bills: billsResult,
  };
}
