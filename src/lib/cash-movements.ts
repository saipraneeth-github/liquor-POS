import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, customers, expenses, salesReturns, supplierPayments } from '../db/schema.js';
import { businessDayBounds } from './business-day.js';
import type { Tx } from './domain-events.js';

type Runner = Tx | typeof db;

/**
 * Cash that went into or out of the drawer WITHOUT a bill: khata repayments taken in cash, and expenses paid in cash.
 * Both used to be missing from the drawer arithmetic, so a day with a repayment showed a false surplus and a day with
 * a cash expense a false shortage.
 */

/** Cash khata repayments of a branch recorded in [from, to), optionally only those taken by one person. */
export async function cashRepaymentsBetween(runner: Runner, branchId: string, from: Date, to: Date, recordedById?: string): Promise<string> {
  const [row] = await runner
    .select({ total: sql<string>`coalesce(sum(${creditTransactions.amount}), 0)::text` })
    .from(creditTransactions)
    .innerJoin(customers, eq(customers.id, creditTransactions.customerId))
    .where(and(
      eq(customers.branchId, branchId),
      eq(creditTransactions.type, 'REPAYMENT'),
      eq(creditTransactions.paymentMode, 'CASH'),
      gte(creditTransactions.recordedAt, from),
      lt(creditTransactions.recordedAt, to),
      recordedById ? eq(creditTransactions.recordedById, recordedById) : undefined,
    ));
  return row?.total ?? '0';
}

/** Cash paid out for a business date: expenses, and payments to suppliers made in cash (each carries its own date). */
export async function cashExpensesOnDate(runner: Runner, branchId: string, businessDate: string): Promise<string> {
  const [paidToSuppliers] = await runner
    .select({ total: sql<string>`coalesce(sum(${supplierPayments.amount}), 0)::text` })
    .from(supplierPayments)
    .where(and(eq(supplierPayments.branchId, branchId), eq(supplierPayments.paymentMode, 'CASH'), eq(supplierPayments.paymentDate, businessDate), isNull(supplierPayments.voidedAt)));
  const [row] = await runner
    .select({ total: sql<string>`(coalesce(sum(${expenses.amount}), 0) + ${paidToSuppliers?.total ?? '0'}::numeric)::text` })
    .from(expenses)
    .where(and(eq(expenses.branchId, branchId), eq(expenses.paymentMode, 'CASH'), eq(expenses.expenseDate, businessDate), isNull(expenses.voidedAt)));
  return row?.total ?? '0';
}

/** Cash expenses one person recorded in [from, to): what left THEIR drawer during a shift. */
export async function cashExpensesRecordedBetween(runner: Runner, branchId: string, from: Date, to: Date, recordedById: string): Promise<string> {
  const [row] = await runner
    .select({ total: sql<string>`coalesce(sum(${expenses.amount}), 0)::text` })
    .from(expenses)
    .where(and(
      eq(expenses.branchId, branchId), eq(expenses.paymentMode, 'CASH'), eq(expenses.recordedById, recordedById), isNull(expenses.voidedAt),
      gte(expenses.createdAt, from), lt(expenses.createdAt, to),
    ));
  return row?.total ?? '0';
}
