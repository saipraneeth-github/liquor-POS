import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, branchProductCosts, products, stock, stockAudit, stockTransferItems, stockTransfers, users } from '../../db/schema.js';
import { addStockDeltas } from '../../lib/stock-delta.js';
import { logAudit } from '../../lib/audit.js';
import { businessDateOf } from '../../lib/business-day.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { planReceipt, validateDispatch } from './transfer.engine.js';

export const CreateTransferSchema = z.object({
  fromBranchId: z.string().uuid(),
  toBranchId: z.string().uuid(),
  note: z.string().trim().max(300).optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(100_000) })).min(1).max(500),
});
export const ReceiveTransferSchema = z.object({
  items: z.array(z.object({ productId: z.string().uuid(), receivedQuantity: z.number().int().min(0).max(100_000) })).max(500).optional(),
});
export const CancelTransferSchema = z.object({ reason: z.string().trim().min(5, 'Say why the transfer is cancelled').max(300) });
export const ListTransfersSchema = z.object({
  branchId: z.string().uuid(),
  status: z.enum(['IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional(),
});

export type CreateTransferInput = z.infer<typeof CreateTransferSchema>;

const transferNumber = () => `TR-${businessDateOf().replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;

/** The two outlets of a transfer (the route needs them to check access before the service runs). */
export async function transferBranches(id: string): Promise<{ fromBranchId: string; toBranchId: string; status: string } | null> {
  const [row] = await db.select({ fromBranchId: stockTransfers.fromBranchId, toBranchId: stockTransfers.toBranchId, status: stockTransfers.status })
    .from(stockTransfers).where(eq(stockTransfers.id, id)).limit(1);
  return row ?? null;
}

/** Dispatch: bottles leave the sender's default counter now and travel as IN_TRANSIT. */
export async function createTransfer(input: CreateTransferInput, user: JwtPayload) {
  if (input.fromBranchId === input.toBranchId) throw new BusinessRuleError('Choose two different outlets');
  const problems = validateDispatch(input.items);
  if (problems.length > 0) throw new BusinessRuleError(problems.join('; '));

  const created = await db.transaction(async (tx) => {
    const found = await tx.select({ id: branches.id, syndicateId: branches.syndicateId }).from(branches)
      .where(inArray(branches.id, [input.fromBranchId, input.toBranchId]));
    const from = found.find((b) => b.id === input.fromBranchId);
    const to = found.find((b) => b.id === input.toBranchId);
    if (!from || !to) throw new NotFoundError('Outlet not found');
    // Only between the outlets of ONE business: a transfer is not a sale to somebody else
    if (!from.syndicateId || from.syndicateId !== to.syndicateId) throw new BusinessRuleError('Both outlets must belong to the same business');

    const ids = input.items.map((i) => i.productId);
    const prods = await tx.select({ id: products.id, name: products.name, syndicateId: products.syndicateId }).from(products).where(inArray(products.id, ids));
    const nameOf = new Map(prods.map((p) => [p.id, p.name]));
    const bad = ids.filter((id) => { const p = prods.find((x) => x.id === id); return !p || p.syndicateId !== from.syndicateId; });
    if (bad.length > 0) throw new BusinessRuleError(`One or more products not found: ${bad.join(', ')}`);

    const [transfer] = await tx.insert(stockTransfers).values({
      transferNumber: transferNumber(), fromBranchId: input.fromBranchId, toBranchId: input.toBranchId, note: input.note ?? null, createdById: user.sub,
    }).returning();

    for (const item of input.items) {
      // Out of the default counter only: the other sale types' counters (Janata ...) keep their bottles
      const [updated] = await tx.update(stock)
        .set({ quantity: sql`${stock.quantity} - ${item.quantity}` })
        .where(and(
          eq(stock.branchId, input.fromBranchId), eq(stock.productId, item.productId),
          sql`${stock.quantity} - ${item.quantity} >= coalesce((SELECT sum(sbt.quantity) FROM stock_by_type sbt WHERE sbt.branch_id = ${stock.branchId} AND sbt.product_id = ${stock.productId}), 0)`,
        ))
        .returning({ quantity: stock.quantity });
      if (!updated) {
        const [cur] = await tx.select({ quantity: stock.quantity }).from(stock).where(and(eq(stock.branchId, input.fromBranchId), eq(stock.productId, item.productId))).limit(1);
        throw new BusinessRuleError(`Insufficient stock for ${nameOf.get(item.productId)}: sending ${item.quantity}, available in the default counter ${cur?.quantity ?? 0}`);
      }
    }
    await tx.insert(stockTransferItems).values(input.items.map((i) => ({ transferId: transfer.id, productId: i.productId, quantity: i.quantity })));
    await tx.insert(stockAudit).values(input.items.map((i) => ({
      branchId: input.fromBranchId, productId: i.productId, userId: user.sub, changeQty: -i.quantity, reason: 'TRANSFER_OUT' as const, referenceId: transfer.id,
    })));
    return transfer;
  });
  await logAudit(user.sub, 'stock.transfer.send', { type: 'stock_transfer', id: created.id }, { number: created.transferNumber, from: input.fromBranchId, to: input.toBranchId, lines: input.items.length });
  return getTransfer(created.id);
}

/** Receipt: the bottles that arrived go into the receiver's default counter; any shortfall stays on the line as lost in transit. */
export async function receiveTransfer(id: string, input: z.infer<typeof ReceiveTransferSchema>, user: JwtPayload) {
  const outcome = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for('update');
    if (!t) throw new NotFoundError('Transfer not found');
    if (t.status !== 'IN_TRANSIT') throw new ConflictError(`This transfer is already ${t.status.toLowerCase()}`);
    const items = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, id));

    let plan;
    try { plan = planReceipt(items.map((i) => ({ productId: i.productId, quantity: i.quantity })), input.items); }
    catch (err) { throw new BusinessRuleError((err as Error).message); }

    const arrived = plan.lines.filter((l) => l.received > 0);
    if (arrived.length > 0) {
      await addStockDeltas(tx, arrived.map((l) => ({ branchId: t.toBranchId, productId: l.productId, quantity: l.received })));
      await tx.insert(stockAudit).values(arrived.map((l) => ({
        branchId: t.toBranchId, productId: l.productId, userId: user.sub, changeQty: l.received, reason: 'TRANSFER_IN' as const, referenceId: id,
      })));
      // The receiving outlet has no cost of its own for a bottle it never bought: it starts from what the sender paid
      for (const l of arrived) {
        await tx.execute(sql`
          INSERT INTO branch_product_costs (branch_id, product_id, cost_price, cost_per_case)
          SELECT ${t.toBranchId}::uuid, ${l.productId}::uuid, cost_price, cost_per_case FROM branch_product_costs
          WHERE branch_id = ${t.fromBranchId}::uuid AND product_id = ${l.productId}::uuid
          ON CONFLICT (branch_id, product_id) DO NOTHING`);
      }
    }
    for (const l of plan.lines) {
      await tx.update(stockTransferItems).set({ receivedQuantity: l.received }).where(and(eq(stockTransferItems.transferId, id), eq(stockTransferItems.productId, l.productId)));
    }
    await tx.update(stockTransfers).set({ status: 'RECEIVED', receivedById: user.sub, receivedAt: new Date() }).where(eq(stockTransfers.id, id));
    return { number: t.transferNumber, plan };
  });
  await logAudit(user.sub, 'stock.transfer.receive', { type: 'stock_transfer', id }, { number: outcome.number, received: outcome.plan.totalReceived, shortage: outcome.plan.totalShortage });
  return getTransfer(id);
}

/** Cancel while still in transit: the bottles go back to the sender. */
export async function cancelTransfer(id: string, reason: string, user: JwtPayload) {
  const number = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for('update');
    if (!t) throw new NotFoundError('Transfer not found');
    if (t.status !== 'IN_TRANSIT') throw new ConflictError(`This transfer is already ${t.status.toLowerCase()}`);
    const items = await tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, id));
    await addStockDeltas(tx, items.map((i) => ({ branchId: t.fromBranchId, productId: i.productId, quantity: i.quantity })));
    await tx.insert(stockAudit).values(items.map((i) => ({
      branchId: t.fromBranchId, productId: i.productId, userId: user.sub, changeQty: i.quantity, reason: 'TRANSFER_IN' as const, referenceId: id,
    })));
    await tx.update(stockTransfers).set({ status: 'CANCELLED', cancelledById: user.sub, cancelledAt: new Date(), cancelReason: reason }).where(eq(stockTransfers.id, id));
    return t.transferNumber;
  });
  await logAudit(user.sub, 'stock.transfer.cancel', { type: 'stock_transfer', id }, { number, reason });
  return getTransfer(id);
}

async function hydrate(rows: (typeof stockTransfers.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const items = await db.select({
    transferId: stockTransferItems.transferId, productId: stockTransferItems.productId, quantity: stockTransferItems.quantity,
    receivedQuantity: stockTransferItems.receivedQuantity, name: products.name,
  }).from(stockTransferItems).innerJoin(products, eq(products.id, stockTransferItems.productId)).where(inArray(stockTransferItems.transferId, ids));
  const branchIds = [...new Set(rows.flatMap((r) => [r.fromBranchId, r.toBranchId]))];
  const names = await db.select({ id: branches.id, name: branches.name }).from(branches).where(inArray(branches.id, branchIds));
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const userIds = [...new Set(rows.flatMap((r) => [r.createdById, r.receivedById].filter((x): x is string => !!x)))];
  const people = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds));
  const personOf = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => {
    const lines = items.filter((i) => i.transferId === r.id);
    return {
      ...r,
      fromBranchName: nameOf.get(r.fromBranchId) ?? '', toBranchName: nameOf.get(r.toBranchId) ?? '',
      createdByName: personOf.get(r.createdById) ?? '', receivedByName: r.receivedById ? personOf.get(r.receivedById) ?? '' : null,
      items: lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, receivedQuantity: l.receivedQuantity })),
      totalBottles: lines.reduce((n, l) => n + l.quantity, 0),
      shortage: r.status === 'RECEIVED' ? lines.reduce((n, l) => n + (l.quantity - (l.receivedQuantity ?? l.quantity)), 0) : 0,
    };
  });
}

export async function getTransfer(id: string) {
  const [row] = await db.select().from(stockTransfers).where(eq(stockTransfers.id, id)).limit(1);
  if (!row) throw new NotFoundError('Transfer not found');
  return (await hydrate([row]))[0];
}

/** The other outlets of the same business that an outlet can send to (a branch user cannot list branches themselves). */
export async function transferDestinations(branchId: string) {
  const [me] = await db.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!me?.syndicateId) return { branches: [] };
  const rows = await db.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches)
    .where(and(eq(branches.syndicateId, me.syndicateId), sql`${branches.id} <> ${branchId}`));
  return { branches: rows };
}

/** Transfers an outlet sent or is due to receive, newest first. */
export async function listTransfers(q: z.infer<typeof ListTransfersSchema>) {
  const rows = await db.select().from(stockTransfers)
    .where(and(or(eq(stockTransfers.fromBranchId, q.branchId), eq(stockTransfers.toBranchId, q.branchId)), q.status ? eq(stockTransfers.status, q.status) : undefined))
    .orderBy(desc(stockTransfers.createdAt)).limit(200);
  return { transfers: await hydrate(rows) };
}
