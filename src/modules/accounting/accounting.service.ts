import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { accountLedgers, branches, journalLines, journalVouchers } from '../../db/schema.js';
import { businessDateOf, isIsoDate } from '../../lib/business-day.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { ensureSystemLedgers, isReservedLedgerCode, normalizeLedgerCode, type LedgerGroup } from './chart.js';
import { buildVoucher } from './ledger.engine.js';
import { insertVoucher } from './posting.service.js';
import {
  computeBalanceSheet,
  computeLedgerBalances,
  computeProfitLoss,
  computeRunningBalance,
  computeTrialBalance,
  type LedgerMovement,
} from './reports.engine.js';
import { vouchersToTallyXml, type TallyVoucher } from './tally.exporter.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const ISO_DATE = z.string().refine(isIsoDate, 'must be YYYY-MM-DD');
// numeric(14,2) columns (journal_lines, opening_balance): at most 12 integer digits
const MONEY = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'must be a non-negative amount (max 12 integer digits, up to 2 decimals)');
const SIGNED_MONEY = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'must be an amount (max 12 integer digits, up to 2 decimals)');

export const LEDGER_GROUPS = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export const VOUCHER_TYPES = ['SALES', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'JOURNAL', 'CONTRA'] as const;

export const DateRangeQuerySchema = z.object({
  from: ISO_DATE.optional(),
  to:   ISO_DATE.optional(),
}).refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });

export const VoucherQuerySchema = z.object({
  from:  ISO_DATE.optional(),
  to:    ISO_DATE.optional(),
  type:  z.enum(VOUCHER_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
}).refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });

export const AsOfQuerySchema = z.object({ asOf: ISO_DATE.optional() });

export const CreateLedgerSchema = z.object({
  name:           z.string().trim().min(2).max(100),
  code:           z.string().trim().min(2).max(60).optional(),
  group:          z.enum(LEDGER_GROUPS),
  openingBalance: SIGNED_MONEY.optional().default('0'),   // signed: + debit, - credit
});

export const ManualJournalSchema = z.object({
  voucherDate: ISO_DATE.optional(),
  narration:   z.string().trim().min(3).max(500),
  lines: z.array(z.object({
    ledgerId: z.string().uuid(),
    debit:    MONEY.optional(),
    credit:   MONEY.optional(),
  })).min(2).max(100),
});

export type DateRangeQuery = z.infer<typeof DateRangeQuerySchema>;
export type VoucherQuery = z.infer<typeof VoucherQuerySchema>;
export type CreateLedgerInput = z.infer<typeof CreateLedgerSchema>;
export type ManualJournalInput = z.infer<typeof ManualJournalSchema>;

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function assertBranchExists(branchId: string): Promise<void> {
  const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new NotFoundError('Branch not found');
}

async function loadLedgers(branchId: string) {
  await assertBranchExists(branchId);
  await db.transaction(async (tx) => { await ensureSystemLedgers(tx, branchId); });
  return db
    .select()
    .from(accountLedgers)
    .where(eq(accountLedgers.branchId, branchId))
    .orderBy(asc(accountLedgers.group), asc(accountLedgers.code));
}

/** Per-ledger journal sums for the branch in [from, to] (either bound optional). */
async function movements(
  branchId: string,
  range: { from?: string; to?: string; before?: string },
  includeOpening: boolean,
): Promise<LedgerMovement[]> {
  const ledgers = await loadLedgers(branchId);
  const conds: SQL[] = [eq(journalVouchers.branchId, branchId)];
  if (range.from) conds.push(gte(journalVouchers.voucherDate, range.from));
  if (range.to) conds.push(lte(journalVouchers.voucherDate, range.to));
  if (range.before) conds.push(lt(journalVouchers.voucherDate, range.before));

  const sums = await db
    .select({
      ledgerId: journalLines.ledgerId,
      debit:    sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
      credit:   sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalVouchers, eq(journalLines.voucherId, journalVouchers.id))
    .where(and(...conds))
    .groupBy(journalLines.ledgerId);
  const byLedger = new Map(sums.map((s) => [s.ledgerId, s]));

  return ledgers.map((l) => ({
    ledgerId:       l.id,
    code:           l.code,
    name:           l.name,
    group:          l.group as LedgerGroup,
    openingBalance: includeOpening ? l.openingBalance : '0',
    debit:          byLedger.get(l.id)?.debit ?? '0',
    credit:         byLedger.get(l.id)?.credit ?? '0',
  }));
}

async function linesForVouchers(voucherIds: string[]) {
  if (voucherIds.length === 0) return new Map<string, { ledgerId: string; ledgerCode: string; ledgerName: string; debit: string; credit: string }[]>();
  const rows = await db
    .select({
      voucherId:  journalLines.voucherId,
      ledgerId:   journalLines.ledgerId,
      ledgerCode: accountLedgers.code,
      ledgerName: accountLedgers.name,
      debit:      journalLines.debit,
      credit:     journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(accountLedgers, eq(journalLines.ledgerId, accountLedgers.id))
    .where(inArray(journalLines.voucherId, voucherIds))
    .orderBy(desc(journalLines.debit), asc(accountLedgers.code));
  const map = new Map<string, { ledgerId: string; ledgerCode: string; ledgerName: string; debit: string; credit: string }[]>();
  for (const { voucherId, ...line } of rows) {
    const list = map.get(voucherId) ?? [];
    list.push(line);
    map.set(voucherId, list);
  }
  return map;
}

// ─── LEDGERS ─────────────────────────────────────────────────────────────────

export async function listLedgers(branchId: string, asOf?: string) {
  const rows = computeLedgerBalances(await movements(branchId, { to: asOf }, true));
  return {
    branchId,
    asOf: asOf ?? null,
    ledgers: rows.map(({ ledgerId, ...rest }) => ({ id: ledgerId, ...rest })),
  };
}

export async function createLedger(branchId: string, input: CreateLedgerInput) {
  const code = normalizeLedgerCode(input.code ?? input.name);
  if (isReservedLedgerCode(code)) {
    throw new BusinessRuleError(`Ledger code ${code} is reserved for system ledgers`);
  }
  await assertBranchExists(branchId);
  await db.transaction(async (tx) => { await ensureSystemLedgers(tx, branchId); });

  // Tally imports ledgers by NAME, so names must be unique within the branch (case-insensitive)
  const [sameName] = await db
    .select({ code: accountLedgers.code })
    .from(accountLedgers)
    .where(and(eq(accountLedgers.branchId, branchId), sql`lower(${accountLedgers.name}) = lower(${input.name})`))
    .limit(1);
  if (sameName) throw new ConflictError(`A ledger named "${input.name}" already exists in this branch (${sameName.code})`);

  const [ledger] = await db
    .insert(accountLedgers)
    .values({
      branchId,
      code,
      name:           input.name,
      group:          input.group,
      isSystem:       false,
      openingBalance: input.openingBalance,
    })
    .onConflictDoNothing({ target: [accountLedgers.branchId, accountLedgers.code] })
    .returning();
  if (!ledger) throw new ConflictError(`A ledger with code ${code} already exists in this branch`);
  return ledger;
}

export async function getLedgerStatement(branchId: string, ledgerId: string, range: DateRangeQuery) {
  const [ledger] = await db
    .select()
    .from(accountLedgers)
    .where(and(eq(accountLedgers.id, ledgerId), eq(accountLedgers.branchId, branchId)))
    .limit(1);
  if (!ledger) throw new NotFoundError('Ledger not found');

  // Opening = ledger opening + everything before `from`
  let opening = ledger.openingBalance;
  if (range.from) {
    const [before] = await db
      .select({ net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::text` })
      .from(journalLines)
      .innerJoin(journalVouchers, eq(journalLines.voucherId, journalVouchers.id))
      .where(and(eq(journalLines.ledgerId, ledgerId), lt(journalVouchers.voucherDate, range.from)));
    opening = new Decimal(ledger.openingBalance).plus(before?.net ?? '0').toFixed(2);
  }

  const conds: SQL[] = [eq(journalLines.ledgerId, ledgerId)];
  if (range.from) conds.push(gte(journalVouchers.voucherDate, range.from));
  if (range.to) conds.push(lte(journalVouchers.voucherDate, range.to));
  const entries = await db
    .select({
      voucherId:     journalVouchers.id,
      voucherNumber: journalVouchers.voucherNumber,
      voucherDate:   journalVouchers.voucherDate,
      voucherType:   journalVouchers.voucherType,
      narration:     journalVouchers.narration,
      debit:         journalLines.debit,
      credit:        journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalVouchers, eq(journalLines.voucherId, journalVouchers.id))
    .where(and(...conds))
    .orderBy(asc(journalVouchers.voucherDate), asc(journalVouchers.createdAt), asc(journalVouchers.voucherNumber));

  return {
    ledger: { id: ledger.id, code: ledger.code, name: ledger.name, group: ledger.group },
    from: range.from ?? null,
    to: range.to ?? null,
    ...computeRunningBalance(opening, entries),
  };
}

// ─── VOUCHERS (DAY BOOK) ─────────────────────────────────────────────────────

async function queryVouchers(branchId: string, q: { from?: string; to?: string; type?: string; limit?: number }) {
  const conds: SQL[] = [eq(journalVouchers.branchId, branchId)];
  if (q.from) conds.push(gte(journalVouchers.voucherDate, q.from));
  if (q.to) conds.push(lte(journalVouchers.voucherDate, q.to));
  if (q.type) conds.push(eq(journalVouchers.voucherType, q.type as (typeof VOUCHER_TYPES)[number]));
  const base = db
    .select()
    .from(journalVouchers)
    .where(and(...conds))
    .orderBy(asc(journalVouchers.voucherDate), asc(journalVouchers.createdAt), asc(journalVouchers.voucherNumber));
  // Fetch one extra row so a capped day book can say it was truncated
  const fetched = q.limit ? await base.limit(q.limit + 1) : await base;
  const hasMore = q.limit ? fetched.length > q.limit : false;
  const vouchers = hasMore ? fetched.slice(0, q.limit) : fetched;
  const lines = await linesForVouchers(vouchers.map((v) => v.id));
  return { hasMore, vouchers: vouchers.map((v) => ({ ...v, lines: lines.get(v.id) ?? [] })) };
}

export async function listVouchers(branchId: string, q: VoucherQuery) {
  const { vouchers, hasMore } = await queryVouchers(branchId, q);
  return { branchId, from: q.from ?? null, to: q.to ?? null, type: q.type ?? null, count: vouchers.length, hasMore, vouchers };
}

export async function createManualJournal(branchId: string, input: ManualJournalInput, user: JwtPayload) {
  await assertBranchExists(branchId);
  const ledgerIds = [...new Set(input.lines.map((l) => l.ledgerId))];
  const found = await db
    .select({ id: accountLedgers.id })
    .from(accountLedgers)
    .where(and(eq(accountLedgers.branchId, branchId), inArray(accountLedgers.id, ledgerIds)));
  if (found.length !== ledgerIds.length) {
    throw new BusinessRuleError('One or more ledgers do not belong to this branch');
  }

  // Engine validation (balanced, one side per line) → plain Error → 422
  const lines = buildVoucher(input.lines.map((l) => ({ ledger: l.ledgerId, debit: l.debit, credit: l.credit })));
  if (lines.length !== input.lines.length) {
    throw new BusinessRuleError('Every journal line needs a debit or a credit amount');
  }

  return db.transaction(async (tx) => {
    const posted = await insertVoucher(tx, {
      branchId,
      voucherDate: input.voucherDate ?? businessDateOf(),
      voucherType: 'JOURNAL',
      narration:   input.narration,
      sourceType:  'MANUAL',
      sourceId:    null,
      createdById: user.sub,
    }, lines);
    if (!posted) throw new ConflictError('Voucher already posted');
    return { ...posted.voucher, lines: posted.lines };
  });
}

// ─── REPORTS ─────────────────────────────────────────────────────────────────

export async function getTrialBalance(branchId: string, asOf?: string) {
  return { branchId, asOf: asOf ?? null, ...computeTrialBalance(await movements(branchId, { to: asOf }, true)) };
}

export async function getProfitLoss(branchId: string, range: DateRangeQuery) {
  return {
    branchId,
    from: range.from ?? null,
    to: range.to ?? null,
    ...computeProfitLoss(await movements(branchId, range, false)),
  };
}

export async function getBalanceSheet(branchId: string, asOf?: string) {
  return { branchId, asOf: asOf ?? null, ...computeBalanceSheet(await movements(branchId, { to: asOf }, true)) };
}

// ─── TALLY EXPORT ────────────────────────────────────────────────────────────

export async function exportTally(branchId: string, range: DateRangeQuery, companyName?: string, includeMasters = true) {
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new NotFoundError('Branch not found');

  const ledgers = await loadLedgers(branchId);
  const names = new Map(ledgers.map((l) => [l.code, l.name]));
  const { vouchers } = await queryVouchers(branchId, range);
  const tallyVouchers: TallyVoucher[] = vouchers.map((v) => ({
    voucherNumber: v.voucherNumber,
    voucherDate:   v.voucherDate,
    voucherType:   v.voucherType,
    narration:     v.narration,
    lines:         v.lines.map((l) => ({ ledgerCode: l.ledgerCode, debit: l.debit, credit: l.credit })),
  }));

  const usedCodes = new Set(tallyVouchers.flatMap((v) => v.lines.map((l) => l.ledgerCode)));
  const masters = includeMasters
    ? ledgers.filter((l) => usedCodes.has(l.code)).map((l) => ({ code: l.code, name: l.name, group: l.group }))
    : undefined;

  const xml = vouchersToTallyXml(tallyVouchers, names, companyName?.trim() || branch.name, masters);
  const filename = `tally-${branch.code}-${range.from ?? 'start'}-${range.to ?? 'today'}.xml`.replace(/[^A-Za-z0-9._-]/g, '_');
  return { xml, filename, voucherCount: tallyVouchers.length };
}
