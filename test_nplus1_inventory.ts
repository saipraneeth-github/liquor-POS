// Just putting my thoughts out loud.
// We can modify `applyApprovedInvoice` to batch inserts and updates for `stock`, `stockAudit`, `products` and `priceAudit`.
// Right now, it does an insert for every single item!
// We can use `.values(itemsToInsert)` to batch them, saving network round trips to PostgreSQL.

// For `stock`, we can do a single `insert().values().onConflictDoUpdate()`!
// For `stockAudit`, we can do a single `insert().values()`!
// For `products`, it's a bit tricky because Drizzle doesn't support batch update natively easily without raw SQL with CASE WHEN...
// BUT wait, can we batch update in Drizzle? It doesn't natively support it, so doing `await Promise.all(updates)` is the standard way,
// which still does multiple queries but concurrently.

// BUT wait... what about `billing.service.ts` ?
// `computeStockDeltas` returns array of deltas.
// Currently it loops over deltas:
// await tx.update(stock).set({ quantity: sql`${stock.quantity} - ${qty}` }).where(and(eq(stock.branchId, input.branchId), eq(stock.productId, delta.productId), gte(stock.quantity, qty)))
// Wait, `update()` in a loop. We can use Promise.all() for performance, OR we could potentially check out if there are N+1 issues somewhere else?

// Let's check `src/modules/accounting/ledger.engine.ts` for N+1 issues.
