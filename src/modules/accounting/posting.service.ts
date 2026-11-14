import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { accountLedgers, branches, journalLines, journalVouchers } from '../../db/schema.js';
import { onDomainEvent, type Tx, type DomainEventMap } from '../../lib/domain-events.js';
import { businessDateOf } from '../../lib/business-day.js';
import { NotFoundError } from '../../lib/errors.js';
import { branchCodeOf } from '../../lib/branch-code.js';
import { ensureLedger, ensureSystemLedgers, expenseLedgerDefinition } from './chart.js';
import {
  assertBalanced,
  billPaidLines,
  billVoidedLines,
  counterSheetSalesLines,
  creditRepaymentLines,
  expenseLines,
  supplierInvoiceLines,
  supplierChallanPaymentLines,
  reverseLines,
  type CounterSheetSaleLine,
  type PostingLine,
} from './ledger.engine.js';
import { Decimal } from 'decimal.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export type VoucherType = 'SALES' | 'PURCHASE' | 'PAYMENT' | 'RECEIPT' | 'JOURNAL' | 'CONTRA';
export type SourceType = 'BILL' | 'BILL_VOID' | 'SUPPLIER_INVOICE' | 'SUPPLIER_CHALLAN' | 'SUPPLIER_INVOICE_REVERSAL' | 'SUPPLIER_CHALLAN_REVERSAL'
  | 'COUNTER_SHEET' | 'COUNTER_SHEET_SUPERSEDED' | 'COUNTER_SHEET_VOID' | 'EXPENSE' | 'CREDIT_REPAYMENT' | 'BANK_LINE' | 'MANUAL';

export interface VoucherHeader {
  branchId: string;
  voucherDate: string;           // YYYY-MM-DD (business date)
  voucherType: VoucherType;
  narration: string;
  sourceType: SourceType;
  sourceId: string | null;
  createdById: string | null;
}

export type VoucherRow = typeof journalVouchers.$inferSelect;
export type JournalLineRow = typeof journalLines.$inferSelect;

// ─── VOUCHER NUMBERING ───────────────────────────────────────────────────────

/** JV-<branchCode>-<YYYYMMDD>-<8 hex>. Uniqueness is enforced by the DB. */
export function formatVoucherNumber(branchCode: string, voucherDate: string, shortId: string): string {
  return `JV-${branchCode}-${voucherDate.replace(/-/g, '')}-${shortId.toUpperCase()}`;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

// ─── LOW-LEVEL POSTING ───────────────────────────────────────────────────────

/**
 * Inserts a balanced voucher whose lines reference ledger IDS. Returns null (no-op) when a
 * voucher already exists for (sourceType, sourceId) — uq_voucher_source makes posting idempotent.
 */
export async function insertVoucher(
  tx: Tx,
  header: VoucherHeader,
  lines: PostingLine[],
): Promise<{ voucher: VoucherRow; lines: JournalLineRow[] } | null> {
  assertBalanced(lines);
  const code = await branchCodeOf(tx, header.branchId);

  const values = {
    branchId:      header.branchId,
    voucherNumber: formatVoucherNumber(code, header.voucherDate, shortId()),
    voucherDate:   header.voucherDate,
    voucherType:   header.voucherType,
    narration:     header.narration,
    sourceType:    header.sourceType,
    sourceId:      header.sourceId,
    createdById:   header.createdById,
  };

  const inserted = header.sourceId
    ? await tx.insert(journalVouchers).values(values)
        .onConflictDoNothing({ target: [journalVouchers.sourceType, journalVouchers.sourceId] })
        .returning()
    : await tx.insert(journalVouchers).values(values).returning();
  const voucher = inserted[0];
  if (!voucher) return null;

  const insertedLines = await tx.insert(journalLines).values(
    lines.map((l) => ({ voucherId: voucher.id, ledgerId: l.ledger, debit: l.debit, credit: l.credit })),
  ).returning();
  return { voucher, lines: insertedLines };
}

/** Posts lines keyed by ledger CODE (system postings). Ensures the chart exists first. */
async function postByCode(
  tx: Tx,
  header: VoucherHeader,
  lines: PostingLine[],
  extraLedgerIds: Map<string, string> = new Map(),
) {
  const ids = await ensureSystemLedgers(tx, header.branchId);
  for (const [code, id] of extraLedgerIds) ids.set(code, id);
  const byId = lines.map((l) => {
    const id = ids.get(l.ledger);
    if (!id) throw new Error(`Ledger ${l.ledger} is not set up for branch ${header.branchId}`);
    return { ...l, ledger: id };
  });
  return insertVoucher(tx, header, byId);
}

/** Lines (by ledger code) of the voucher posted for a source, or null. */
async function findSourceVoucherLines(tx: Tx, sourceType: SourceType, sourceId: string): Promise<PostingLine[] | null> {
  const [voucher] = await tx
    .select({ id: journalVouchers.id })
    .from(journalVouchers)
    .where(and(eq(journalVouchers.sourceType, sourceType), eq(journalVouchers.sourceId, sourceId)))
    .limit(1);
  if (!voucher) return null;
  const rows = await tx
    .select({ code: accountLedgers.code, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(accountLedgers, eq(journalLines.ledgerId, accountLedgers.id))
    .where(eq(journalLines.voucherId, voucher.id));
  return rows.map((r) => ({ ledger: r.code, debit: r.debit, credit: r.credit }));
}

function dateOf(...candidates: (Date | string | null | undefined)[]): string {
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string') return c.slice(0, 10);
    return businessDateOf(c);
  }
  return businessDateOf(new Date());
}

// ─── EVENT HANDLERS ──────────────────────────────────────────────────────────

export async function postBillPaid({ bill }: DomainEventMap['bill.paid'], tx: Tx) {
  return postByCode(tx, {
    branchId:    bill.branchId,
    voucherDate: dateOf(bill.paidAt, bill.createdAt),
    voucherType: 'SALES',
    narration:   `Sales bill ${bill.billNumber} (${bill.paymentMode ?? 'CASH'})`,
    sourceType:  'BILL',
    sourceId:    bill.id,
    createdById: bill.cashierId,
  }, billPaidLines(bill));
}

export async function postBillVoided({ bill, voidedById }: DomainEventMap['bill.voided'], tx: Tx) {
  // Exact reversal of what was posted; fall back to re-deriving it (bill paid before accounting existed).
  // A bill that was never paid has no sale to reverse — posting one would invent a negative sale.
  const posted = await findSourceVoucherLines(tx, 'BILL', bill.id);
  if (!posted && !bill.paidAt) return null;
  const original = posted ?? billPaidLines(bill);
  return postByCode(tx, {
    branchId:    bill.branchId,
    voucherDate: dateOf(bill.voidedAt),
    voucherType: 'JOURNAL',
    narration:   `Reversal of bill ${bill.billNumber}${bill.voidReason ? `: ${bill.voidReason}` : ''}`,
    sourceType:  'BILL_VOID',
    sourceId:    bill.id,
    createdById: voidedById ?? null,
  }, billVoidedLines(original));
}

export async function postSupplierInvoiceApproved({ invoice, items }: DomainEventMap['supplierInvoice.approved'], tx: Tx) {
  if (invoice.challanAmount && new Decimal(invoice.challanAmount).gt(0)) {
    const challanNarration = invoice.challanNumber
      ? `e-Challan/DD payment ${invoice.challanNumber} for ${invoice.supplierName}`
      : `e-Challan/DD advance payment for ${invoice.supplierName}`;
    await postByCode(tx, {
      branchId:    invoice.branchId,
      voucherDate: dateOf(invoice.invoiceDate, invoice.approvedAt, invoice.createdAt),
      voucherType: 'PAYMENT',
      narration:   challanNarration,
      sourceType:  'SUPPLIER_CHALLAN',
      sourceId:    invoice.id,
      createdById: invoice.approvedById ?? invoice.createdById,
    }, supplierChallanPaymentLines(invoice.challanAmount));
  }

  return postByCode(tx, {
    branchId:    invoice.branchId,
    voucherDate: dateOf(invoice.invoiceDate, invoice.approvedAt, invoice.createdAt),
    voucherType: 'PURCHASE',
    narration:   `Purchase invoice ${invoice.invoiceNumber} from ${invoice.supplierName}`,
    sourceType:  'SUPPLIER_INVOICE',
    sourceId:    invoice.id,
    createdById: invoice.approvedById ?? invoice.createdById,
  }, supplierInvoiceLines(items, invoice.mrpRoundingOff, invoice.specialExciseCess, invoice.tcsAmount, invoice.turnoverTax));
}

/**
 * An approved supplier invoice was reversed: exact reversing vouchers for the purchase and for the e-challan payment
 * that came with it. The originals are never deleted — the books keep the full trail.
 */
export async function postSupplierInvoiceReversed({ invoice, reversedById }: DomainEventMap['supplierInvoice.reversed'], tx: Tx) {
  const header = (sourceType: SourceType, voucherType: VoucherType, narration: string): VoucherHeader => ({
    branchId: invoice.branchId, voucherDate: businessDateOf(), voucherType, narration,
    sourceType, sourceId: invoice.id, createdById: reversedById ?? null,
  });
  const challan = await findSourceVoucherLines(tx, 'SUPPLIER_CHALLAN', invoice.id);
  if (challan) {
    await postByCode(tx, header('SUPPLIER_CHALLAN_REVERSAL', 'JOURNAL', `Reversal of e-challan payment for invoice ${invoice.invoiceNumber} (${invoice.supplierName})`), reverseLines(challan));
  }
  const purchase = await findSourceVoucherLines(tx, 'SUPPLIER_INVOICE', invoice.id);
  if (purchase) {
    await postByCode(tx, header('SUPPLIER_INVOICE_REVERSAL', 'JOURNAL', `Reversal of purchase invoice ${invoice.invoiceNumber} from ${invoice.supplierName}`), reverseLines(purchase));
  }
}

// ─── COUNTER SHEETS ──────────────────────────────────────────────────────────

export interface CounterSheetSalesInput {
  branchId: string;
  sheetId: string;
  sheetDate: string;
  typeName: string;
  userId: string | null;
  lines: CounterSheetSaleLine[];
}

/** Sales found by a counter sheet that no POS bill covered: one SALES voucher per sheet (idempotent). */
export async function postCounterSheetSales(tx: Tx, input: CounterSheetSalesInput) {
  const lines = counterSheetSalesLines(input.lines);
  return postByCode(tx, {
    branchId:    input.branchId,
    voucherDate: input.sheetDate,
    voucherType: 'SALES',
    narration:   `Counter sheet ${input.sheetDate} (${input.typeName}): sales not billed through the POS`,
    sourceType:  'COUNTER_SHEET',
    sourceId:    input.sheetId,
    createdById: input.userId,
  }, lines);
}

/**
 * The sheet went back to draft: reverse its voucher. The original and the reversal are kept (no deletion), but moved off
 * the (sourceType, sourceId) key so that posting the corrected sheet again creates a fresh voucher.
 */
export async function reverseCounterSheetSales(tx: Tx, input: { branchId: string; sheetId: string; sheetDate: string; userId: string | null }) {
  const [original] = await tx.select().from(journalVouchers)
    .where(and(eq(journalVouchers.sourceType, 'COUNTER_SHEET'), eq(journalVouchers.sourceId, input.sheetId))).limit(1);
  if (!original) return null;
  const posted = await findSourceVoucherLines(tx, 'COUNTER_SHEET', input.sheetId);
  if (!posted) return null;
  await tx.update(journalVouchers)
    .set({ sourceType: 'COUNTER_SHEET_SUPERSEDED', sourceId: null, narration: `${original.narration} [reversed: sheet ${input.sheetId}]` })
    .where(eq(journalVouchers.id, original.id));
  return postByCode(tx, {
    branchId:    input.branchId,
    voucherDate: businessDateOf(),
    voucherType: 'JOURNAL',
    narration:   `Reversal of counter sheet ${input.sheetDate} sales (sheet ${input.sheetId} reopened)`,
    sourceType:  'COUNTER_SHEET_VOID',
    sourceId:    null,
    createdById: input.userId,
  }, reverseLines(posted));
}

export async function postCreditRepayment({ customer, txn }: DomainEventMap['credit.repayment'], tx: Tx) {
  if (txn.type !== 'REPAYMENT') return null;
  return postByCode(tx, {
    branchId:    customer.branchId,
    voucherDate: dateOf(txn.recordedAt),
    voucherType: 'RECEIPT',
    narration:   `Khata repayment from ${customer.name} (${customer.phone})`,
    sourceType:  'CREDIT_REPAYMENT',
    sourceId:    txn.id,
    createdById: txn.recordedById,
  }, creditRepaymentLines({ amount: txn.amount, paymentMode: txn.paymentMode }));
}

export async function postExpenseRecorded({ expense }: DomainEventMap['expense.recorded'], tx: Tx) {
  const def = expenseLedgerDefinition(expense.category);
  const ledgerId = await ensureLedger(tx, expense.branchId, def);
  return postByCode(tx, {
    branchId:    expense.branchId,
    voucherDate: dateOf(expense.expenseDate),
    voucherType: 'PAYMENT',
    narration:   `${expense.category} expense${expense.notes ? `: ${expense.notes}` : ''}`,
    sourceType:  'EXPENSE',
    sourceId:    expense.id,
    createdById: expense.recordedById,
  }, expenseLines(expense), new Map([[def.code, ledgerId]]));
}

// ─── REGISTRATION ────────────────────────────────────────────────────────────

let unsubscribers: (() => void)[] | null = null;

/**
 * Subscribes the accounting handlers to the domain events. Idempotent: a second call is a no-op.
 * Call once at app startup (buildApp). Even if handlers were somehow registered twice,
 * uq_voucher_source + ON CONFLICT DO NOTHING keeps posting single.
 */
export function registerAccountingHandlers(): void {
  if (unsubscribers) return;
  unsubscribers = [
    onDomainEvent('bill.paid', async (p, tx) => { await postBillPaid(p, tx); }),
    onDomainEvent('bill.voided', async (p, tx) => { await postBillVoided(p, tx); }),
    onDomainEvent('supplierInvoice.approved', async (p, tx) => { await postSupplierInvoiceApproved(p, tx); }),
    onDomainEvent('supplierInvoice.reversed', async (p, tx) => { await postSupplierInvoiceReversed(p, tx); }),
    onDomainEvent('credit.repayment', async (p, tx) => { await postCreditRepayment(p, tx); }),
    onDomainEvent('expense.recorded', async (p, tx) => { await postExpenseRecorded(p, tx); }),
  ];
}

/** Removes the accounting handlers (tests). */
export function unregisterAccountingHandlers(): void {
  for (const off of unsubscribers ?? []) off();
  unsubscribers = null;
}
