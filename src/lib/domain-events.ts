/**
 * domain-events.ts — tiny typed in-process domain-event registry.
 *
 * Handlers run INSIDE the emitting db transaction (awaited sequentially, in registration
 * order) and receive the transaction handle, so side-postings (e.g. accounting vouchers)
 * are atomic with the business operation. A handler that throws rolls the whole
 * operation back.
 */

import type { DB } from '../db/client.js';
import type {
  bills,
  billItems,
  supplierInvoices,
  supplierInvoiceItems,
  customers,
  creditTransactions,
  expenses,
} from '../db/schema.js';

// ─── TYPES ────────────────────────────────────────────────────────────────────

/** Drizzle transaction handle (same API as `db`). */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export interface DomainEventMap {
  'bill.paid':                { bill: typeof bills.$inferSelect; items: (typeof billItems.$inferSelect)[] };
  'bill.voided':              { bill: typeof bills.$inferSelect; items: (typeof billItems.$inferSelect)[] };
  'supplierInvoice.approved': { invoice: typeof supplierInvoices.$inferSelect; items: (typeof supplierInvoiceItems.$inferSelect)[] };
  'credit.repayment':         { customer: typeof customers.$inferSelect; txn: typeof creditTransactions.$inferSelect };
  'expense.recorded':         { expense: typeof expenses.$inferSelect };
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEventHandler<K extends DomainEventName> =
  (payload: DomainEventMap[K], tx: Tx) => Promise<void> | void;

// ─── REGISTRY ─────────────────────────────────────────────────────────────────

const handlers = new Map<DomainEventName, DomainEventHandler<any>[]>();

/** Registers a handler. Returns an unsubscribe function. */
export function onDomainEvent<K extends DomainEventName>(name: K, handler: DomainEventHandler<K>): () => void {
  const list = handlers.get(name) ?? [];
  list.push(handler);
  handlers.set(name, list);
  return () => {
    const current = handlers.get(name);
    if (!current) return;
    const idx = current.indexOf(handler);
    if (idx >= 0) current.splice(idx, 1);
  };
}

/** Runs every handler for `name` sequentially inside `tx`. Errors propagate (→ rollback). */
export async function emitDomainEvent<K extends DomainEventName>(name: K, payload: DomainEventMap[K], tx: Tx): Promise<void> {
  const list = handlers.get(name);
  if (!list || list.length === 0) return;
  for (const handler of [...list]) {
    await handler(payload, tx);
  }
}

/** Removes handlers for one event, or all events. Intended for tests. */
export function clearDomainEventHandlers(name?: DomainEventName): void {
  if (name) handlers.delete(name);
  else handlers.clear();
}

export function domainEventHandlerCount(name: DomainEventName): number {
  return handlers.get(name)?.length ?? 0;
}
