/**
 * customer.service.ts — DB-backed customer khata (credit) operations.
 * Pure rules live in credit.engine.ts.
 */

import { z } from 'zod';
import { db } from '../../db/client.js';
import { customers, creditTransactions } from '../../db/schema.js';
import { and, asc, desc, eq, gt, ilike, or } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { emitDomainEvent } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import {
  applyRepayment,
  assertCreditLimitUpdate,
  buildStatement,
  normalizeIndianMobile,
} from './credit.engine.js';
import type { JwtPayload } from '../auth/auth.service.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

// numeric(12,2): at most 10 integer digits, so oversized values fail validation (400), not the DB.
const DECIMAL = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be a decimal string with up to 10 integer digits and 2dp');
const PHONE = z.string().trim().transform((v, ctx) => {
  const n = normalizeIndianMobile(v);
  if (!n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'phone must be a valid 10-digit Indian mobile number' });
    return z.NEVER;
  }
  return n;
});

export const CreateCustomerSchema = z.object({
  name:          z.string().trim().min(1).max(200),
  phone:         PHONE,
  creditAllowed: z.boolean().optional(),
  creditLimit:   DECIMAL.optional(),
});

export const UpdateCustomerSchema = z.object({
  name:          z.string().trim().min(1).max(200).optional(),
  phone:         PHONE.optional(),
  creditAllowed: z.boolean().optional(),
  creditLimit:   DECIMAL.optional(),
  isActive:      z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field is required' });

export const REPAYMENT_MODES = ['CASH', 'CARD', 'UPI'] as const;

export const RepaymentSchema = z.object({
  amount:      DECIMAL.refine((v) => new Decimal(v).greaterThan(0), 'amount must be greater than zero'),
  paymentMode: z.enum(REPAYMENT_MODES),
  notes:       z.string().trim().max(500).optional(),
  clientRef:   z.string().trim().min(1).max(64).optional(),
});

export const ListCustomersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit:  z.coerce.number().int().min(1).max(500).default(100),
});

export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
export type RepaymentInput = z.infer<typeof RepaymentSchema>;
export type CustomerRow = typeof customers.$inferSelect;

// ─── LOOKUP ──────────────────────────────────────────────────────────────────

export async function getCustomerById(id: string): Promise<CustomerRow | null> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return row ?? null;
}

/** Customers of a branch; `search` matches name (case-insensitive) or phone substring. */
export async function listCustomers(branchId: string, search: string | undefined, limit: number) {
  const conditions = [eq(customers.branchId, branchId)];
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(customers.name, pattern), ilike(customers.phone, pattern))!);
  }
  return db.select().from(customers)
    .where(and(...conditions))
    .orderBy(asc(customers.name))
    .limit(limit);
}

// ─── CREATE / UPDATE ─────────────────────────────────────────────────────────

export async function createCustomer(branchId: string, input: CreateCustomerInput): Promise<CustomerRow> {
  try {
    const [row] = await db.insert(customers).values({
      branchId,
      name:          input.name,
      phone:         input.phone,
      creditAllowed: input.creditAllowed ?? false,
      creditLimit:   new Decimal(input.creditLimit ?? '0').toFixed(2),
    }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A customer with this phone already exists in this branch');
    throw err;
  }
}

export async function updateCustomer(id: string, input: UpdateCustomerInput): Promise<CustomerRow> {
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx.select().from(customers).where(eq(customers.id, id)).for('update');
      if (!current) throw new NotFoundError('Customer not found');

      if (input.creditLimit !== undefined) {
        try {
          assertCreditLimitUpdate(input.creditLimit, current.currentCredit);
        } catch (err) {
          throw new BusinessRuleError((err as Error).message);
        }
      }

      const patch: Partial<typeof customers.$inferInsert> = {};
      if (input.name !== undefined)          patch.name = input.name;
      if (input.phone !== undefined)         patch.phone = input.phone;
      if (input.creditAllowed !== undefined) patch.creditAllowed = input.creditAllowed;
      if (input.creditLimit !== undefined)   patch.creditLimit = new Decimal(input.creditLimit).toFixed(2);
      if (input.isActive !== undefined)      patch.isActive = input.isActive;

      const [updated] = await tx.update(customers).set(patch).where(eq(customers.id, id)).returning();
      return updated;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A customer with this phone already exists in this branch');
    throw err;
  }
}

// ─── STATEMENT ───────────────────────────────────────────────────────────────

export async function getCustomerStatement(customer: CustomerRow) {
  const rows = await db.select().from(creditTransactions)
    .where(eq(creditTransactions.customerId, customer.id))
    .orderBy(asc(creditTransactions.recordedAt));

  const { entries, closingBalance } = buildStatement(rows);
  return {
    customer,
    entries,
    closingBalance,
    outstanding: new Decimal(customer.currentCredit).toFixed(2),
  };
}

// ─── REPAYMENT ───────────────────────────────────────────────────────────────

/**
 * Records a repayment. Locks the customer row, rejects amounts above the outstanding
 * balance, writes a REPAYMENT transaction and emits `credit.repayment` in the same tx.
 */
export async function recordRepayment(customerId: string, input: RepaymentInput, user: JwtPayload) {
  return db.transaction(async (tx) => {
    const [customer] = await tx.select().from(customers).where(eq(customers.id, customerId)).for('update');
    if (!customer) throw new NotFoundError('Customer not found');

    // Idempotent replay: the customer row lock serialises same-key submissions, so this check is race-free
    if (input.clientRef) {
      const [existing] = await tx.select().from(creditTransactions)
        .where(eq(creditTransactions.clientRef, input.clientRef)).limit(1);
      if (existing) {
        if (existing.customerId !== customerId) throw new ConflictError('clientRef already used for another customer');
        return { customer, txn: existing, replayed: true };
      }
    }

    let balanceAfter: string;
    try {
      balanceAfter = applyRepayment(customer.currentCredit, input.amount);
    } catch (err) {
      throw new BusinessRuleError((err as Error).message);
    }

    const [updatedCustomer] = await tx.update(customers)
      .set({ currentCredit: balanceAfter })
      .where(eq(customers.id, customerId))
      .returning();

    const [txn] = await tx.insert(creditTransactions).values({
      customerId,
      type:         'REPAYMENT',
      amount:       new Decimal(input.amount).toFixed(2),
      balanceAfter,
      paymentMode:  input.paymentMode,
      recordedById: user.sub,
      clientRef:    input.clientRef ?? null,
      notes:        input.notes ?? null,
    }).returning();

    await emitDomainEvent('credit.repayment', { customer: updatedCustomer, txn }, tx);

    return { customer: updatedCustomer, txn, replayed: false };
  });
}

// ─── OUTSTANDING ─────────────────────────────────────────────────────────────

export async function getOutstanding(branchId: string) {
  const rows = await db.select().from(customers)
    .where(and(eq(customers.branchId, branchId), gt(customers.currentCredit, '0')))
    .orderBy(desc(customers.currentCredit));

  const total = rows.reduce((acc, r) => acc.plus(r.currentCredit), new Decimal(0));
  return { customers: rows, count: rows.length, totalOutstanding: total.toFixed(2) };
}
