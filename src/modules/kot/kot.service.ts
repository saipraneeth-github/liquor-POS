/**
 * kot.service.ts — DB-backed KOT operations.
 * Delegates status validation to kot.engine.ts.
 */

import { db } from '../../db/client.js';
import { kotOrders, kotItems, tableSessions, products, productServings, categories, stock, stockAudit } from '../../db/schema.js';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { canTransitionKotItem, consolidateKotOrders, type KotItemStatus, type KotOrder } from './kot.engine.js';
import { resolveTaxRate } from '../billing/billing.engine.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { assertBranchCanSell } from '../menu/menu-access.js';
import { deductMl, splitUnitsAndMl } from '../menu/serving.engine.js';
import { explicitSums } from '../saletypes/saletype.service.js';
import type { Tx } from '../../lib/domain-events.js';

export interface CreateKotInput {
  tableSessionId: string;
  branchId: string;
  createdById: string;
  destination?: 'KITCHEN' | 'BAR';
  notes?: string;
  items: Array<{
    productId: string;
    servingId?: string;
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
      .select({
        id: products.id, name: products.name, mrp: products.mrp, isActive: products.isActive,
        taxRate: categories.taxRate, gstRate: products.gstRate, isAvailable: products.isAvailable,
        syndicateId: products.syndicateId, trackStock: products.trackStock, menuType: products.menuType,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(inArray(products.id, productIds));
    const productMap = new Map(productRows.map((p) => [p.id, p]));
    const missing = productIds.filter((id) => !productMap.get(id)?.isActive);
    if (missing.length > 0) throw new BusinessRuleError(`Unknown or inactive products: ${missing.join(', ')}`);
    await assertBranchCanSell(tx, input.branchId, productRows);

    const servingIds = [...new Set(input.items.flatMap((i) => (i.servingId ? [i.servingId] : [])))];
    const servingRows = servingIds.length
      ? await tx.select().from(productServings).where(inArray(productServings.id, servingIds))
      : [];
    const servingMap = new Map(servingRows.map((s) => [s.id, s]));

    // Stock is only verified for whole bottles sold at the bar (not kitchen dishes, peg servings, or non-tracked items)
    const isKitchenOrder = input.destination === 'KITCHEN';
    const bottleItems = isKitchenOrder
      ? []
      : input.items.filter((i) => {
          if (i.servingId) return false;
          const p = productMap.get(i.productId);
          return p && p.trackStock === true && p.menuType !== 'KITCHEN';
        });
    if (bottleItems.length > 0) {
      const stockEntries = await tx
        .select({ productId: stock.productId, quantity: stock.quantity })
        .from(stock)
        .where(and(eq(stock.branchId, input.branchId), inArray(stock.productId, bottleItems.map((b) => b.productId))));
      const stockMap = new Map(stockEntries.map((s) => [s.productId, s.quantity]));
      for (const item of bottleItems) {
        const available = stockMap.get(item.productId) ?? 0;
        if (item.quantity > available) {
          const p = productMap.get(item.productId);
          throw new BusinessRuleError(`Insufficient stock for ${p?.name ?? 'item'}: requested ${item.quantity}, available ${available}`);
        }
      }
    }

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
      const serving = i.servingId ? servingMap.get(i.servingId) : undefined;
      if (i.servingId && (!serving || serving.productId !== i.productId || !serving.isActive)) {
        throw new BusinessRuleError(`Serving not available for ${product.name}`);
      }
      return {
        kotOrderId: order.id,
        productId:  i.productId,
        quantity:   i.quantity,
        unitPrice:  serving?.price ?? product.mrp,
        taxRate:    resolveTaxRate(product.taxRate, product.gstRate),
        servingId:    serving?.id ?? null,
        servingLabel: serving?.label ?? null,
        servingMl:    serving?.volumeMl ?? null,
        notes:      i.notes ?? null,
      };
    });

    const insertedItems = await tx.insert(kotItems).values(itemRows).returning();

    return { ...order, items: insertedItems };
  });
}

// ─── STOCK DEDUCTION ON SERVE ─────────────────────────────────────────────────

async function deductStockForServedItems(
  tx: Tx,
  branchId: string,
  itemsToServe: Array<{ id: string; productId: string; quantity: number; servingMl?: number | null; kotOrderId: string }>,
  userId?: string,
) {
  const validItems = itemsToServe.filter((i) => i.quantity > 0);
  if (validItems.length === 0) return;

  const productIds = [...new Set(validItems.map((i) => i.productId))];
  const productRows = await tx
    .select({
      id: products.id,
      name: products.name,
      trackStock: products.trackStock,
      volumeMl: products.volumeMl,
    })
    .from(products)
    .where(inArray(products.id, productIds));
  const productMap = new Map(productRows.map((p) => [p.id, p]));

  const trackedItems = validItems.filter((i) => productMap.get(i.productId)?.trackStock);
  if (trackedItems.length === 0) return;

  const { units, ml: mlByProduct } = splitUnitsAndMl(
    trackedItems.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      servingMl: i.servingMl ?? null,
    }))
  );

  const trackedProductIds = [...new Set([...units.keys(), ...mlByProduct.keys()])];
  const reservedMap = await explicitSums(tx, branchId, trackedProductIds);

  // 1. Whole units (bottles)
  for (const [productId, quantity] of units) {
    const prod = productMap.get(productId)!;
    const reserved = reservedMap.get(productId) ?? 0;

    const [row] = await tx
      .select({ quantity: stock.quantity })
      .from(stock)
      .where(and(eq(stock.branchId, branchId), eq(stock.productId, productId)))
      .for('update');

    const totalQty = row?.quantity ?? 0;
    const available = totalQty - reserved;
    if (available < quantity) {
      throw new BusinessRuleError(
        `Insufficient stock: ${prod.name} (requested ${quantity}, available ${Math.max(0, available)})`
      );
    }

    await tx
      .update(stock)
      .set({ quantity: sql`${stock.quantity} - ${quantity}` })
      .where(and(eq(stock.branchId, branchId), eq(stock.productId, productId)));

    const refOrderId = trackedItems.find((i) => i.productId === productId)?.kotOrderId;
    await tx.insert(stockAudit).values({
      branchId,
      productId,
      userId: userId ?? null,
      changeQty: -quantity,
      changeMl: 0,
      reason: 'SALE',
      referenceId: refOrderId,
    });
  }

  // 2. Peg / ml servings
  for (const [productId, totalMl] of mlByProduct) {
    const prod = productMap.get(productId)!;
    const reserved = reservedMap.get(productId) ?? 0;
    const bottleSize = prod.volumeMl || 750;

    const [row] = await tx
      .select({ quantity: stock.quantity, openMl: stock.openMl })
      .from(stock)
      .where(and(eq(stock.branchId, branchId), eq(stock.productId, productId)))
      .for('update');

    if (!row) {
      throw new BusinessRuleError(`Insufficient stock: ${prod.name} (${totalMl} ml requested, available 0)`);
    }

    const result = deductMl(row, totalMl, bottleSize);
    if (!result || result.state.quantity < reserved) {
      throw new BusinessRuleError(`Insufficient stock: ${prod.name} (${totalMl} ml requested)`);
    }

    await tx
      .update(stock)
      .set({ quantity: result.state.quantity, openMl: result.state.openMl })
      .where(and(eq(stock.branchId, branchId), eq(stock.productId, productId)));

    const refOrderId = trackedItems.find((i) => i.productId === productId)?.kotOrderId;
    await tx.insert(stockAudit).values({
      branchId,
      productId,
      userId: userId ?? null,
      changeQty: -result.bottlesOpened,
      changeMl: -totalMl,
      reason: 'SALE',
      referenceId: refOrderId,
    });
  }
}

// ─── UPDATE KOT ITEM STATUS ───────────────────────────────────────────────────

export async function updateKotItemStatus(
  kotOrderId: string,
  itemId: string,
  newStatus: KotItemStatus,
  branchId: string,
  userId?: string,
) {
  return db.transaction(async (tx) => {
    // Item must belong to an order in the caller's branch
    const [item] = await tx
      .select({
        id: kotItems.id,
        status: kotItems.status,
        productId: kotItems.productId,
        quantity: kotItems.quantity,
        servingMl: kotItems.servingMl,
        kotOrderId: kotItems.kotOrderId,
      })
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

    // Deduct stock when item is served
    if (newStatus === 'SERVED' && item.status !== 'SERVED') {
      await deductStockForServedItems(tx, branchId, [item], userId);
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

// ─── SERVE ALL KOT ITEMS (BATCH) ─────────────────────────────────────────────

export async function serveAllKotOrderItems(kotOrderId: string, branchId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: kotOrders.id })
      .from(kotOrders)
      .where(and(eq(kotOrders.id, kotOrderId), eq(kotOrders.branchId, branchId)));
    if (!order) throw new NotFoundError(`KOT order not found.`);

    const itemsToServe = await tx
      .select({
        id: kotItems.id,
        productId: kotItems.productId,
        quantity: kotItems.quantity,
        servingMl: kotItems.servingMl,
        kotOrderId: kotItems.kotOrderId,
      })
      .from(kotItems)
      .where(and(
        eq(kotItems.kotOrderId, kotOrderId),
        inArray(kotItems.status, ['PENDING', 'PREPARING']),
      ));

    if (itemsToServe.length > 0) {
      await deductStockForServedItems(tx, branchId, itemsToServe, userId);
    }

    const updated = await tx
      .update(kotItems)
      .set({ status: 'SERVED' })
      .where(and(
        eq(kotItems.kotOrderId, kotOrderId),
        inArray(kotItems.status, ['PENDING', 'PREPARING'])
      ))
      .returning();

    const allItems = await tx
      .select({ status: kotItems.status })
      .from(kotItems)
      .where(eq(kotItems.kotOrderId, kotOrderId));

    let orderStatus: 'PENDING' | 'PREPARING' | 'SERVED' | 'CANCELLED' = 'PENDING';
    if (allItems.length > 0 && allItems.every((i) => i.status === 'SERVED' || i.status === 'CANCELLED')) {
      orderStatus = allItems.every((i) => i.status === 'CANCELLED') ? 'CANCELLED' : 'SERVED';
    } else if (allItems.some((i) => i.status === 'PREPARING' || i.status === 'SERVED')) {
      orderStatus = 'PREPARING';
    }

    await tx.update(kotOrders).set({ updatedAt: new Date(), status: orderStatus }).where(eq(kotOrders.id, kotOrderId));
    return updated;
  });
}

export async function serveAllSessionKotItems(tableSessionId: string, branchId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const orders = await tx
      .select({ id: kotOrders.id })
      .from(kotOrders)
      .where(and(eq(kotOrders.tableSessionId, tableSessionId), eq(kotOrders.branchId, branchId)));

    if (!orders.length) return [];
    const orderIds = orders.map((o) => o.id);

    const itemsToServe = await tx
      .select({
        id: kotItems.id,
        productId: kotItems.productId,
        quantity: kotItems.quantity,
        servingMl: kotItems.servingMl,
        kotOrderId: kotItems.kotOrderId,
      })
      .from(kotItems)
      .where(and(
        inArray(kotItems.kotOrderId, orderIds),
        inArray(kotItems.status, ['PENDING', 'PREPARING']),
      ));

    if (itemsToServe.length > 0) {
      await deductStockForServedItems(tx, branchId, itemsToServe, userId);
    }

    const updated = await tx
      .update(kotItems)
      .set({ status: 'SERVED' })
      .where(and(
        inArray(kotItems.kotOrderId, orderIds),
        inArray(kotItems.status, ['PENDING', 'PREPARING'])
      ))
      .returning();

    for (const orderId of orderIds) {
      const allItems = await tx
        .select({ status: kotItems.status })
        .from(kotItems)
        .where(eq(kotItems.kotOrderId, orderId));

      let orderStatus: 'PENDING' | 'PREPARING' | 'SERVED' | 'CANCELLED' = 'PENDING';
      if (allItems.length > 0 && allItems.every((i) => i.status === 'SERVED' || i.status === 'CANCELLED')) {
        orderStatus = allItems.every((i) => i.status === 'CANCELLED') ? 'CANCELLED' : 'SERVED';
      } else if (allItems.some((i) => i.status === 'PREPARING' || i.status === 'SERVED')) {
        orderStatus = 'PREPARING';
      }
      await tx.update(kotOrders).set({ updatedAt: new Date(), status: orderStatus }).where(eq(kotOrders.id, orderId));
    }

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

  // All items in one query joined with products for name & menuType
  const items = await db
    .select({
      id: kotItems.id,
      kotOrderId: kotItems.kotOrderId,
      productId: kotItems.productId,
      quantity: kotItems.quantity,
      unitPrice: kotItems.unitPrice,
      taxRate: kotItems.taxRate,
      servingId: kotItems.servingId,
      servingLabel: kotItems.servingLabel,
      servingMl: kotItems.servingMl,
      status: kotItems.status,
      notes: kotItems.notes,
      productName: products.name,
      menuType: products.menuType,
    })
    .from(kotItems)
    .leftJoin(products, eq(kotItems.productId, products.id))
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
    destination:    order.destination,
    status:         order.status as KotItemStatus,
    items: (byOrder.get(order.id) ?? []).map((i) => ({
      id:           i.id,
      kotOrderId:   i.kotOrderId,
      productId:    i.productId,
      productName:  i.productName ?? undefined,
      menuType:     i.menuType ?? undefined,
      quantity:     i.quantity,
      unitPrice:    new Decimal(i.unitPrice),
      taxRate:      new Decimal(i.taxRate),
      servingId:    i.servingId,
      servingLabel: i.servingLabel,
      status:       i.status as KotItemStatus,
      notes:        i.notes,
    })),
  }));
}

// ─── CONSOLIDATE SESSION BILL ─────────────────────────────────────────────────

export async function getConsolidatedBill(tableSessionId: string, branchId: string) {
  const orders = await getKotOrdersForSession(tableSessionId, branchId);
  return consolidateKotOrders(orders);
}
