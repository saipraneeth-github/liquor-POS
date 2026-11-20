import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { assertBusinessDayOpen } from '../../lib/closed-day.js';
import { logAudit } from '../../lib/audit.js';
import { db } from '../../db/client.js';
import { branches, expenses } from '../../db/schema.js';
import { emitDomainEvent } from '../../lib/domain-events.js';
import { businessDateOf, isIsoDate } from '../../lib/business-day.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { summarizeExpenses } from './expense.engine.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const EXPENSE_PAYMENT_MODES = ['CASH', 'CARD', 'UPI', 'BANK'] as const;

const ISO_DATE = z.string().refine(isIsoDate, 'must be YYYY-MM-DD');

export const RecordExpenseSchema = z.object({
  category:    z.string().trim().min(2).max(60).regex(/[A-Za-z0-9]/, 'category must contain a letter or digit'),
  // numeric(12,2): at most 10 integer digits
  amount:      z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'amount must be at most 9999999999.99 with up to 2 decimals')
                 .refine((v) => new Decimal(v).greaterThan(0), 'amount must be greater than zero'),
  paymentMode: z.enum(EXPENSE_PAYMENT_MODES),
  expenseDate: ISO_DATE.optional(),   // defaults to today's business date
  notes:       z.string().trim().max(500).optional(),
});

export const ListExpensesQuerySchema = z.object({
  from: ISO_DATE.optional(),
  to:   ISO_DATE.optional(),
}).refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });

export type RecordExpenseInput = z.infer<typeof RecordExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof ListExpensesQuerySchema>;

// ─── EXPENSE SERVICE ─────────────────────────────────────────────────────────

/** Inserts the expense and emits expense.recorded (→ accounting voucher) in ONE transaction. */
export async function recordExpense(branchId: string, input: RecordExpenseInput, user: JwtPayload) {
  const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new NotFoundError('Branch not found');

  const expenseDate = input.expenseDate ?? businessDateOf();
  // A cash expense changes that day's drawer: a closed day is final (reopen it first)
  if (input.paymentMode === 'CASH') await assertBusinessDayOpen(db, branchId, expenseDate);

  return db.transaction(async (tx) => {
    const [expense] = await tx.insert(expenses).values({
      branchId,
      category:     input.category,
      amount:       new Decimal(input.amount).toFixed(2),
      paymentMode:  input.paymentMode,
      expenseDate,
      notes:        input.notes ?? null,
      recordedById: user.sub,
    }).returning();

    await emitDomainEvent('expense.recorded', { expense }, tx);
    return expense;
  });
}

export const VoidExpenseSchema = z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(300) });

/**
 * Voids an expense (never a delete): it stays in the list marked VOID, leaves the totals, and a reversing voucher is posted in
 * the same transaction. A cash expense on a closed day cannot be voided until the day is reopened.
 */
export async function voidExpense(expenseId: string, reason: string, user: JwtPayload) {
  const [current] = await db.select().from(expenses).where(eq(expenses.id, expenseId)).limit(1);
  if (!current) throw new NotFoundError('Expense not found');
  if (current.paymentMode === 'CASH') await assertBusinessDayOpen(db, current.branchId, current.expenseDate);

  const voided = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(expenses).where(eq(expenses.id, expenseId)).for('update');
    if (!row) throw new NotFoundError('Expense not found');
    if (row.voidedAt) throw new ConflictError('This expense is already voided');
    const [updated] = await tx.update(expenses)
      .set({ voidedAt: new Date(), voidedById: user.sub, voidReason: reason })
      .where(eq(expenses.id, expenseId)).returning();
    await emitDomainEvent('expense.voided', { expense: updated }, tx);
    return updated;
  });
  await logAudit(user.sub, 'expense.void', { type: 'expense', id: expenseId }, { reason, amount: voided.amount, category: voided.category });
  return voided;
}

export async function listExpenses(branchId: string, query: ListExpensesQuery) {
  const conds: SQL[] = [eq(expenses.branchId, branchId)];
  if (query.from) conds.push(gte(expenses.expenseDate, query.from));
  if (query.to) conds.push(lte(expenses.expenseDate, query.to));
  const rows = await db
    .select()
    .from(expenses)
    .where(and(...conds))
    .orderBy(asc(expenses.expenseDate), asc(expenses.createdAt));
  // A voided expense stays visible (marked) but is not part of the totals
  const summary = summarizeExpenses(rows.filter((r) => !r.voidedAt));
  return {
    branchId,
    from: query.from ?? null,
    to: query.to ?? null,
    expenses: rows,
    totalsByCategory: summary.byCategory,
    total: summary.total,
    count: summary.count,
    voidedCount: rows.filter((r) => r.voidedAt).length,
  };
}
