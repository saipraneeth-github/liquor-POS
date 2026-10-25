import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, expenses } from '../../db/schema.js';
import { emitDomainEvent } from '../../lib/domain-events.js';
import { businessDateOf, isIsoDate } from '../../lib/business-day.js';
import { NotFoundError } from '../../lib/errors.js';
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

  return db.transaction(async (tx) => {
    const [expense] = await tx.insert(expenses).values({
      branchId,
      category:     input.category,
      amount:       new Decimal(input.amount).toFixed(2),
      paymentMode:  input.paymentMode,
      expenseDate:  input.expenseDate ?? businessDateOf(),
      notes:        input.notes ?? null,
      recordedById: user.sub,
    }).returning();

    await emitDomainEvent('expense.recorded', { expense }, tx);
    return expense;
  });
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
  const summary = summarizeExpenses(rows);
  return {
    branchId,
    from: query.from ?? null,
    to: query.to ?? null,
    expenses: rows,
    totalsByCategory: summary.byCategory,
    total: summary.total,
    count: summary.count,
  };
}
