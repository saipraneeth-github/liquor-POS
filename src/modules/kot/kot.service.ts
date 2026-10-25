/**
 * kot.service.ts — DB-backed KOT operations.
 * Delegates status validation to kot.engine.ts.
 */

import { db } from '../../db/client.js';
import { kotOrders, kotItems, tableSessions, products, categories } from '../../db/schema.js';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { canTransitionKotItem, consolidateKotOrders, type KotItemStatus, type KotOrder } from './kot.engine.js';
import { resolveTaxRate } from '../billing/billing.engine.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';

export interface CreateKotInput {
  tableSessionId: string;
  branchId: string;
  createdById: string;
  destination?: 'KITCHEN' | 'BAR';
  notes?: string;
  items: Array<{
    productId: string;
    quantity: number;
    notes?: string;
  }>;
}

// ─── CREATE KOT ───────────────────────────────────────────────────────────────

/** Prices and tax rates are snapshotted from the DB (MRP + category GST) — never from the client. */
export async function createKotOrder(input: CreateKotInput) {
  if (input.items.length === 0) throw new BusinessRuleError('KOT must have at least one item.');

  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: tableSessions.id })
      .from(tableSessions)
      .where(and(
        eq(tableSessions.id, input.tableSessionId),
        eq(tableSessions.branchId, input.branchId),
        isNull(tableSessions.closedAt),
      ))
      .limit(1);
    if (!session) throw new NotFoundError('Open table session not found in this branch');

    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const productRows = await tx
      .select({ id: products.id, mrp: products.mrp, isActive: products.isActive, taxRate: categories.taxRate })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(inArray(products.id, productIds));
    const productMap = new Map(productRows.map((p) => [p.id, p]));
    const missing = productIds.filter((id) => !productMap.get(id)?.isActive);
    if (missing.length > 0) throw new BusinessRuleError(`Unknown or inactive products: ${missing.join(', ')}`);

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

    const itemRows = input.items.map((i) => {
      const product = productMap.get(i.productId)!;
      return {
        kotOrderId: order.id,
        productId:  i.productId,
        quantity:   i.quantity,
        unitPrice:  product.mrp,
        taxRate:    resolveTaxRate(product.taxRate),
        notes:      i.notes ?? null,
      };
    });

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
    // Item must belong to an order in the caller's branch
    const [item] = await tx
      .select({ id: kotItems.id, status: kotItems.status })
      .from(kotItems)
      .innerJoin(kotOrders, eq(kotItems.kotOrderId, kotOrders.id))
      .where(and(
        eq(kotItems.id, itemId),
        eq(kotItems.kotOrderId, kotOrderId),
        eq(kotOrders.branchId, branchId),
      ));

    if (!item) throw new NotFoundError(`KOT item ${itemId} not found.`);

    if (!canTransitionKotItem(item.status as KotItemStatus, newStatus)) {
      throw new BusinessRuleError(
        `Invalid KOT item status transition: ${item.status} → ${newStatus}.`
      );
    }

    // Conditional update guards against concurrent transitions
    const [updated] = await tx
      .update(kotItems)
      .set({ status: newStatus })
      .where(and(eq(kotItems.id, itemId), eq(kotItems.status, item.status)))
      .returning();
    if (!updated) throw new BusinessRuleError('KOT item status changed concurrently; retry');

    await tx.update(kotOrders).set({ updatedAt: new Date() }).where(eq(kotOrders.id, kotOrderId));

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
    ))
    .orderBy(kotOrders.createdAt);

  if (orders.length === 0) return [];

  // All items in one query
  const items = await db
    .select()
    .from(kotItems)
    .where(inArray(kotItems.kotOrderId, orders.map((o) => o.id)));

  const byOrder = new Map<string, typeof items>();
  for (const i of items) {
    const list = byOrder.get(i.kotOrderId) ?? [];
    list.push(i);
    byOrder.set(i.kotOrderId, list);
  }

  return orders.map((order): KotOrder => ({
    id:             order.id,
    tableSessionId: order.tableSessionId,
    status:         order.status as KotItemStatus,
    items: (byOrder.get(order.id) ?? []).map((i) => ({
      id:         i.id,
      kotOrderId: i.kotOrderId,
      productId:  i.productId,
      quantity:   i.quantity,
      unitPrice:  new Decimal(i.unitPrice),
      taxRate:    new Decimal(i.taxRate),
      status:     i.status as KotItemStatus,
      notes:      i.notes,
    })),
  }));
}

// ─── CONSOLIDATE SESSION BILL ─────────────────────────────────────────────────

export async function getConsolidatedBill(tableSessionId: string, branchId: string) {
  const orders = await getKotOrdersForSession(tableSessionId, branchId);
  return consolidateKotOrders(orders);
}
