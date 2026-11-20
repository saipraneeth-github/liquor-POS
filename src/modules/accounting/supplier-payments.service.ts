import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, purchaseReturns, supplierInvoiceItems, supplierInvoices, supplierPayments } from '../../db/schema.js';
import { emitDomainEvent } from '../../lib/domain-events.js';
import { assertBusinessDayOpen } from '../../lib/closed-day.js';
import { logAudit } from '../../lib/audit.js';
import { businessDateOf, isIsoDate } from '../../lib/business-day.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { buildCreditors, type PayableInvoice } from './creditors.engine.js';

const ISO_DATE = z.string().refine(isIsoDate, 'must be YYYY-MM-DD');

export const RecordSupplierPaymentSchema = z.object({
  supplierName: z.string().trim().min(2).max(120),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'amount must have up to 2 decimals').refine((v) => new Decimal(v).gt(0), 'amount must be greater than zero'),
  paymentMode: z.enum(['CASH', 'UPI', 'CARD', 'BANK']),
  paymentDate: ISO_DATE.optional(),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
});
export const VoidSupplierPaymentSchema = z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(300) });
export const AgeingQuerySchema = z.object({ asOf: ISO_DATE.optional() });
export const ListSupplierPaymentsSchema = z.object({ supplier: z.string().trim().max(120).optional(), from: ISO_DATE.optional(), to: ISO_DATE.optional() });

export async function recordSupplierPayment(branchId: string, input: z.infer<typeof RecordSupplierPaymentSchema>, user: JwtPayload) {
  const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new NotFoundError('Branch not found');
  const paymentDate = input.paymentDate ?? businessDateOf();
  if (paymentDate > businessDateOf()) throw new BusinessRuleError('A payment cannot be dated in the future');
  // Cash paid to a supplier leaves the drawer: a closed day is final (reopen it first)
  if (input.paymentMode === 'CASH') await assertBusinessDayOpen(db, branchId, paymentDate);

  const payment = await db.transaction(async (tx) => {
    const [row] = await tx.insert(supplierPayments).values({
      branchId, supplierName: input.supplierName.replace(/\s+/g, ' '), amount: new Decimal(input.amount).toFixed(2), paymentMode: input.paymentMode,
      paymentDate, reference: input.reference ?? null, notes: input.notes ?? null, recordedById: user.sub,
    }).returning();
    await emitDomainEvent('supplierPayment.recorded', { payment: row }, tx);
    return row;
  });
  return payment;
}

export async function voidSupplierPayment(id: string, reason: string, user: JwtPayload) {
  const [current] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, id)).limit(1);
  if (!current) throw new NotFoundError('Payment not found');
  if (current.paymentMode === 'CASH') await assertBusinessDayOpen(db, current.branchId, current.paymentDate);

  const voided = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(supplierPayments).where(eq(supplierPayments.id, id)).for('update');
    if (!row) throw new NotFoundError('Payment not found');
    if (row.voidedAt) throw new ConflictError('This payment is already voided');
    const [updated] = await tx.update(supplierPayments).set({ voidedAt: new Date(), voidedById: user.sub, voidReason: reason }).where(eq(supplierPayments.id, id)).returning();
    await emitDomainEvent('supplierPayment.voided', { payment: updated }, tx);
    return updated;
  });
  await logAudit(user.sub, 'supplier.payment.void', { type: 'supplier_payment', id }, { reason, amount: voided.amount, supplier: voided.supplierName });
  return voided;
}

export async function listSupplierPayments(branchId: string, q: z.infer<typeof ListSupplierPaymentsSchema>) {
  const conds: SQL[] = [eq(supplierPayments.branchId, branchId)];
  if (q.from) conds.push(gte(supplierPayments.paymentDate, q.from));
  if (q.to) conds.push(lte(supplierPayments.paymentDate, q.to));
  if (q.supplier) conds.push(sql`lower(btrim(${supplierPayments.supplierName})) = ${q.supplier.trim().replace(/\s+/g, ' ').toLowerCase()}`);
  const rows = await db.select().from(supplierPayments).where(and(...conds)).orderBy(asc(supplierPayments.paymentDate), asc(supplierPayments.createdAt));
  const live = rows.filter((r) => !r.voidedAt);
  return { payments: rows, total: live.reduce((n, r) => n.plus(r.amount), new Decimal(0)).toFixed(2), count: live.length };
}

/** What the outlet owes each supplier, aged by invoice date (see creditors.engine.ts for the rules). */
export async function getCreditors(branchId: string, asOf: string = businessDateOf()) {
  // Payable per approved invoice = what approval credited to the creditors ledger (lines + printed charges)
  const rows = await db
    .select({
      id: supplierInvoices.id, supplier: supplierInvoices.supplierName, number: supplierInvoices.invoiceNumber,
      invoiceDate: supplierInvoices.invoiceDate, approvedAt: supplierInvoices.approvedAt, createdAt: supplierInvoices.createdAt,
      lines: sql<string>`coalesce(sum(${supplierInvoiceItems.lineCostTotal}), 0)::text`,
      rounding: supplierInvoices.mrpRoundingOff, turnover: supplierInvoices.turnoverTax, cess: supplierInvoices.specialExciseCess, tcs: supplierInvoices.tcsAmount,
      challan: supplierInvoices.challanAmount,
    })
    .from(supplierInvoices)
    .leftJoin(supplierInvoiceItems, eq(supplierInvoiceItems.invoiceId, supplierInvoices.id))
    .where(and(eq(supplierInvoices.branchId, branchId), eq(supplierInvoices.status, 'APPROVED')))
    .groupBy(supplierInvoices.id);

  const pos = (v: string | null) => (v && new Decimal(v).gt(0) ? new Decimal(v) : new Decimal(0));
  const invoices: PayableInvoice[] = rows.map((r) => ({
    id: r.id, supplier: r.supplier, number: r.number,
    date: businessDateOf(r.invoiceDate ?? r.approvedAt ?? r.createdAt ?? new Date()),
    payable: new Decimal(r.lines).plus(pos(r.rounding)).plus(pos(r.turnover)).plus(pos(r.cess)).plus(pos(r.tcs)).toFixed(2),
    settledByChallan: pos(r.challan).toFixed(2),
  }));

  const pays = await db.select().from(supplierPayments).where(and(eq(supplierPayments.branchId, branchId), sql`${supplierPayments.voidedAt} is null`));
  // goods sent back reduce the debt just like money paid (a debit note)
  const rets = await db.select().from(purchaseReturns).where(eq(purchaseReturns.branchId, branchId));
  const credits = [
    ...pays.map((p) => ({ supplier: p.supplierName, amount: p.amount, date: p.paymentDate })),
    ...rets.map((r) => ({ supplier: r.supplierName, amount: r.amount, date: businessDateOf(r.createdAt) })),
  ];
  return { branchId, ...buildCreditors(invoices, credits, asOf) };
}
