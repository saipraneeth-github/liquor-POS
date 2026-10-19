/**
 * kot.service.ts — DB-backed KOT operations.
 * Delegates status validation to kot.engine.ts.
 */

import { db } from '../../db/client';
import { kotOrders, kotItems } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { canTransitionKotItem, consolidateKotOrders, type KotItemStatus, type KotOrder } from './kot.engine';

export interface CreateKotInput {
  tableSessionId: string;
  branchId: string;
  createdById: string;
  destination?: 'KITCHEN' | 'BAR';
  notes?: string;
  items: Array<{
    productId: string;
    quantity: number;
    unitPrice: string;   // string for safe decimal transport
    taxRate: string;
    notes?: string;
  }>;
}

// ─── CREATE KOT ───────────────────────────────────────────────────────────────

export async function createKotOrder(input: CreateKotInput) {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .insert(kotOrders)
      .values({
        tableSessionId: input.tableSessionId,
        branchId:       input.branchId,
        createdById:    input.createdById,
        destination:    input.destination ?? 'KITCHEN',
        notes:          input.notes ?? null,
      })
      .returning();

    if (input.items.length === 0) throw new Error('KOT must have at least one item.');

    const itemRows = input.items.map((i) => ({
      kotOrderId: order.id,
      productId:  i.productId,
      quantity:   i.quantity,
      unitPrice:  i.unitPrice,
      taxRate:    i.taxRate,
      notes:      i.notes ?? null,
    }));

    const insertedItems = await tx.insert(kotItems).values(itemRows).returning();

    return { ...order, items: insertedItems };
  });
}

// ─── UPDATE KOT ITEM STATUS ───────────────────────────────────────────────────

export async function updateKotItemStatus(
  kotOrderId: string,
  itemId: string,
  newStatus: KotItemStatus,
  branchId: string
) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: kotItems.id, status: kotItems.status })
      .from(kotItems)
      .where(and(eq(kotItems.id, itemId), eq(kotItems.kotOrderId, kotOrderId)));

    if (!item) throw new Error(`KOT item ${itemId} not found.`);

    if (!canTransitionKotItem(item.status as KotItemStatus, newStatus)) {
      throw new Error(
        `Invalid KOT item status transition: ${item.status} → ${newStatus}.`
      );
    }

    const [updated] = await tx
      .update(kotItems)
      .set({ status: newStatus })
      .where(eq(kotItems.id, itemId))
      .returning();

    return updated;
  });
}

// ─── GET KOT ORDERS FOR SESSION ───────────────────────────────────────────────

export async function getKotOrdersForSession(tableSessionId: string, branchId: string) {
  const orders = await db
    .select()
    .from(kotOrders)
    .where(and(
      eq(kotOrders.tableSessionId, tableSessionId),
      eq(kotOrders.branchId, branchId)
    ));

  // Fetch items per order
  const enriched: KotOrder[] = [];
  for (const order of orders) {
    const items = await db
      .select()
      .from(kotItems)
      .where(eq(kotItems.kotOrderId, order.id));

    enriched.push({
      id:             order.id,
      tableSessionId: order.tableSessionId,
      status:         order.status as KotItemStatus,
      items: items.map((i) => ({
        id:         i.id,
        kotOrderId: i.kotOrderId,
        productId:  i.productId,
        quantity:   i.quantity,
        unitPrice:  new Decimal(i.unitPrice),
        taxRate:    new Decimal(i.taxRate),
        status:     i.status as KotItemStatus,
        notes:      i.notes,
      })),
    });
  }

  return enriched;
}

// ─── CONSOLIDATE SESSION BILL ─────────────────────────────────────────────────

export async function getConsolidatedBill(tableSessionId: string, branchId: string) {
  const orders = await getKotOrdersForSession(tableSessionId, branchId);
  return consolidateKotOrders(orders);
}
