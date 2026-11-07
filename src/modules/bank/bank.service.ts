/**
 * bank.service.ts — bank statement import and reconciliation against the books.
 *
 * The "book side" of a bank reconciliation is the BANK ledger itself. Today it holds card/UPI sales (debited when
 * the bill is paid), supplier challans and bank-mode expenses (credited), and khata repayments received by UPI/card.
 * It does NOT hold cash deposits, bank charges, interest or most supplier payments — accepting those statement lines
 * is what posts a new voucher, and that voucher is matched to the line, so the books and the bank converge.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import {
  accountLedgers, bankAccounts, bankIgnoreRules, bankLineMatches, bankStatementLines, bankStatements, branches, journalLines, journalVouchers,
} from '../../db/schema.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { Tx } from '../../lib/domain-events.js';
import { logAudit } from '../../lib/audit.js';
import { canAccessBranch, getAccessibleBranchIds } from '../../middleware/auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { ensureSystemLedgers } from '../accounting/chart.js';
import { insertVoucher } from '../accounting/posting.service.js';
import { detectFileType, decodeText } from '../invoices/extraction/detect-type.js';
import { parseCsvRows, parseXlsxRows } from '../invoices/extraction/tabular.js';
import { extractPdfText } from '../invoices/extraction/pdf-text.js';
import { UnsupportedFileError } from '../invoices/extraction/types.js';
import {
  CATEGORY_SIDE, COLUMN_KEYS, IGNORE_REASONS, MIN_RULE_PATTERN, POSTABLE_CATEGORIES, addDays, assignHashes, detectDayFirst, detectMapping, feePosting,
  matchIgnoreRule, postingForCategory, rowsToLines, scanBalanceHints, suggestMatches, suggestPattern, summarise, textLinesToTable, verifyBalanceChain,
  type BalanceCheck, type BalanceHints, type BankCategory, type BookEntry, type ColumnMapping, type IgnoreReason, type IgnoreRule, type ParsedLine, type Suggestion,
} from './bank.engine.js';

const D = (v: Decimal.Value) => new Decimal(v);
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const TOL = new Decimal('0.005');

type Account = typeof bankAccounts.$inferSelect;
type Statement = typeof bankStatements.$inferSelect;
type Line = typeof bankStatementLines.$inferSelect;

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const MONEY = /^-?\d+(\.\d{1,2})?$/;

export const CreateAccountSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(2).max(80),
  bankName: z.string().trim().max(80).optional(),
  accountLast4: z.string().trim().regex(/^\d{4}$/, 'Enter only the last 4 digits').optional(),
  scope: z.enum(['BRANCH', 'SYNDICATE']).default('BRANCH'),
});
export const UpdateAccountSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  bankName: z.string().trim().max(80).nullable().optional(),
  accountLast4: z.string().trim().regex(/^\d{4}$/, 'Enter only the last 4 digits').nullable().optional(),
  isActive: z.boolean().optional(),
});

const MappingSchema = z.object(Object.fromEntries(COLUMN_KEYS.map((k) => [k, z.number().int().min(0).max(59).optional()]))).strict();

/** Form fields that accompany the uploaded file (all strings, as multipart delivers them). */
export const UploadFieldsSchema = z.object({
  mapping: z.string().max(2000).optional(),
  headerRow: z.string().regex(/^-?\d{1,3}$/).optional(),
  dayFirst: z.enum(['true', 'false']).optional(),
  opening: z.string().regex(MONEY).optional(),
  closing: z.string().regex(MONEY).optional(),
  acceptBalanceMismatch: z.enum(['true', 'false']).optional(),
});
export type UploadFields = z.infer<typeof UploadFieldsSchema>;

export const PostLineSchema = z.object({
  category: z.enum(POSTABLE_CATEGORIES as [BankCategory, ...BankCategory[]]),
  ledgerId: z.string().uuid().optional(),
  narration: z.string().trim().max(200).optional(),
});
export const AcceptSchema = z.object({ postFee: z.boolean().optional() });
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const IgnoreReasonEnum = z.enum(IGNORE_REASONS);

// "Ignore lines like this": text that appears in the narration/reference, optionally limited by side and amount
const RuleFields = z.object({
  pattern: z.string().trim().min(MIN_RULE_PATTERN, `Use at least ${MIN_RULE_PATTERN} characters`).max(80),
  side: z.enum(['ANY', 'IN', 'OUT']).default('ANY'),
  minAmount: z.string().regex(AMOUNT).optional(),
  maxAmount: z.string().regex(AMOUNT).optional(),
  action: z.enum(['SUGGEST', 'AUTO']).default('SUGGEST'),
});
const rangeOk = (r: { minAmount?: string; maxAmount?: string }) => r.minAmount === undefined || r.maxAmount === undefined || D(r.minAmount).lte(r.maxAmount);
export const RuleBodySchema = RuleFields.refine(rangeOk, { message: 'The smallest amount is above the largest', path: ['minAmount'] });
export const CreateRuleSchema = RuleFields.extend({ reason: IgnoreReasonEnum }).refine(rangeOk, { message: 'The smallest amount is above the largest', path: ['minAmount'] });
export const UpdateRuleSchema = z.object({
  pattern: z.string().trim().min(MIN_RULE_PATTERN).max(80).optional(),
  side: z.enum(['ANY', 'IN', 'OUT']).optional(),
  minAmount: z.string().regex(AMOUNT).nullable().optional(),
  maxAmount: z.string().regex(AMOUNT).nullable().optional(),
  reason: IgnoreReasonEnum.optional(),
  action: z.enum(['SUGGEST', 'AUTO']).optional(),
  isActive: z.boolean().optional(),
});
// A reason is required so every ignored line says why (audit); `rule` optionally saves "ignore lines like this" for the account
export const IgnoreSchema = z.object({
  reason: IgnoreReasonEnum,
  note: z.string().trim().max(300).optional(),
  ruleId: z.string().uuid().optional(),     // set when the user confirms a rule's suggestion
  rule: RuleBodySchema.optional(),
});
export const BulkIgnoreSchema = z.object({
  lineIds: z.array(z.string().uuid()).min(1).max(500),
  reason: IgnoreReasonEnum,
  note: z.string().trim().max(300).optional(),
  rule: RuleBodySchema.optional(),
});

export const REASON_LABEL: Record<IgnoreReason, string> = {
  PERSONAL: 'Personal', OTHER_BUSINESS: 'Another business', NOT_OURS: 'Not ours', OTHER: 'Other',
};
export const ManualMatchSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(200),
  postDifference: z.boolean().optional(),
});
export const LinesQuerySchema = z.object({
  status: z.enum(['UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED']).optional(),
  search: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── ACCESS ─────────────────────────────────────────────────────────────────

/**
 * A branch account is visible to people who can access that branch. A SYNDICATE account reads the books of every
 * outlet in the business, so only the owner (who can already see all of them) may use it.
 */
async function authorizeAccount(user: JwtPayload, account: Account): Promise<void> {
  const branchOk = await canAccessBranch(user, account.branchId);
  if (!branchOk || (account.scope === 'SYNDICATE' && user.role !== 'owner')) {
    throw new ForbiddenError('Forbidden: cross-branch access denied');
  }
}

async function loadAccount(user: JwtPayload, id: string): Promise<Account> {
  const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1);
  if (!account) throw new NotFoundError('Bank account not found');
  await authorizeAccount(user, account);
  return account;
}

async function loadStatement(user: JwtPayload, id: string): Promise<{ statement: Statement; account: Account }> {
  const [statement] = await db.select().from(bankStatements).where(eq(bankStatements.id, id)).limit(1);
  if (!statement) throw new NotFoundError('Statement not found');
  return { statement, account: await loadAccount(user, statement.accountId) };
}

async function loadLine(user: JwtPayload, id: string): Promise<{ line: Line; statement: Statement; account: Account }> {
  const [line] = await db.select().from(bankStatementLines).where(eq(bankStatementLines.id, id)).limit(1);
  if (!line) throw new NotFoundError('Statement line not found');
  const { statement, account } = await loadStatement(user, line.statementId);
  return { line, statement, account };
}

/** The branches whose BANK ledgers this account is reconciled against. */
async function scopeBranchIds(account: Account): Promise<string[]> {
  if (account.scope === 'BRANCH' || !account.syndicateId) return [account.branchId];
  const rows = await db.select({ id: branches.id }).from(branches).where(eq(branches.syndicateId, account.syndicateId));
  return rows.map((r) => r.id);
}

// ─── ACCOUNTS ───────────────────────────────────────────────────────────────

export async function createAccount(user: JwtPayload, input: z.infer<typeof CreateAccountSchema>): Promise<Account> {
  let syndicateId: string | null = null;
  if (input.scope === 'SYNDICATE') {
    if (user.role !== 'owner') throw new ForbiddenError('Only the owner can create an account shared by all outlets');
    const [branch] = await db.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, input.branchId)).limit(1);
    if (!branch?.syndicateId) throw new BusinessRuleError('This branch does not belong to a business group, so it cannot have a shared account');
    syndicateId = branch.syndicateId;
  }
  try {
    const [row] = await db.insert(bankAccounts).values({
      branchId: input.branchId, syndicateId, scope: input.scope, name: input.name,
      bankName: input.bankName ?? null, accountLast4: input.accountLast4 ?? null, createdById: user.sub,
    }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A bank account with this name already exists for the branch');
    throw err;
  }
}

export async function listAccounts(user: JwtPayload, branchId?: string): Promise<Account[]> {
  const accessible = await getAccessibleBranchIds(user);
  if (accessible !== 'ALL' && accessible.length === 0) return [];
  const rows = await db.select().from(bankAccounts)
    .where(and(
      accessible === 'ALL' ? undefined : inArray(bankAccounts.branchId, accessible),
      branchId ? eq(bankAccounts.branchId, branchId) : undefined,
    ))
    .orderBy(asc(bankAccounts.name));
  return rows.filter((a) => a.scope === 'BRANCH' || user.role === 'owner');
}

export async function updateAccount(user: JwtPayload, id: string, input: z.infer<typeof UpdateAccountSchema>): Promise<Account> {
  await loadAccount(user, id);
  const patch: Partial<typeof bankAccounts.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.bankName !== undefined) patch.bankName = input.bankName;
  if (input.accountLast4 !== undefined) patch.accountLast4 = input.accountLast4;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (Object.keys(patch).length === 0) throw new BusinessRuleError('Nothing to update');
  try {
    const [row] = await db.update(bankAccounts).set(patch).where(eq(bankAccounts.id, id)).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A bank account with this name already exists for the branch');
    throw err;
  }
}

// ─── PARSING (file → lines) ─────────────────────────────────────────────────

export interface ParseOutcome {
  source: 'CSV' | 'EXCEL' | 'PDF';
  fileHash: string;
  headers: string[];
  headerRow: number;
  mapping: ColumnMapping;
  method: 'HEADER' | 'CONTENT' | 'MANUAL';
  mappingConfidence: number;
  dayFirst: boolean;
  lines: Array<ParsedLine & { hash: string }>;
  skippedRows: number;
  hints: BalanceHints;
  balanceCheck: BalanceCheck;
  periodStart: string | null;
  periodEnd: string | null;
  warnings: string[];
  sampleRows: string[][];          // the first raw rows, so the user can see what the mapping refers to
  totalRows: number;
}

function isPasswordError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'PasswordException' || /password/i.test(e?.message ?? '');
}

export function parseMappingField(raw: string | undefined): ColumnMapping | undefined {
  if (!raw) return undefined;
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new BusinessRuleError('The column mapping is not valid JSON'); }
  const parsed = MappingSchema.safeParse(json);
  if (!parsed.success) throw new BusinessRuleError('The column mapping is invalid');
  const m = parsed.data as ColumnMapping;
  if (m.date === undefined) throw new BusinessRuleError('Map the Date column');
  if (m.debit === undefined && m.credit === undefined && m.amount === undefined) throw new BusinessRuleError('Map the Debit/Credit columns, or a single Amount column');
  return m;
}

export async function parseStatementFile(buf: Buffer, fields: UploadFields = {}): Promise<ParseOutcome> {
  const detected = detectFileType(buf);   // throws UnsupportedFileError (415) for anything that is not CSV / XLSX / PDF / image
  if (detected.kind === 'IMAGE') throw new UnsupportedFileError('Photos of statements are not supported. Download the statement as CSV, Excel (.xlsx) or a PDF.');
  const fileHash = createHash('sha256').update(buf).digest('hex');
  const warnings: string[] = [];

  let rows: string[][];
  let source: ParseOutcome['source'];
  let pdfHints: BalanceHints | null = null;
  let fixedMapping: ColumnMapping | undefined;
  let fixedHeaderRow: number | undefined;

  if (detected.kind === 'CSV') {
    source = 'CSV';
    rows = parseCsvRows(decodeText(buf));
  } else if (detected.kind === 'EXCEL') {
    source = 'EXCEL';
    try { rows = (await parseXlsxRows(buf)).rows; } catch { throw new BusinessRuleError('The Excel workbook could not be read. Re-save it as .xlsx or export to CSV.'); }
  } else {
    source = 'PDF';
    const pdfBuf = detected.offset ? buf.subarray(detected.offset) : buf;
    let text;
    try { text = await extractPdfText(pdfBuf); }
    catch (err) {
      if (isPasswordError(err)) throw new BusinessRuleError('This PDF is password-protected. Open it, remove the password (print to a new PDF) and upload that file.');
      throw new BusinessRuleError('The PDF could not be read. Download the statement again, or use the CSV/Excel version.');
    }
    if (text.ocrPages > 0) warnings.push('OCR_USED');
    const table = textLinesToTable(text.lines.map((l) => l.text));
    rows = table.rows;
    pdfHints = table.hints;
    fixedMapping = table.mapping;
    fixedHeaderRow = table.headerRow;
    if (table.skippedLines > 0) warnings.push(`PDF_LINES_SKIPPED:${table.skippedLines}`);
  }
  if (rows.length === 0) throw new BusinessRuleError('The file has no readable rows.');

  const dayFirstOverride = fields.dayFirst === undefined ? undefined : fields.dayFirst === 'true';
  const manualMapping = parseMappingField(fields.mapping);

  let headerRow: number;
  let mapping: ColumnMapping;
  let method: ParseOutcome['method'];
  let confidence: number;
  let headers: string[] = [];

  if (manualMapping) {
    mapping = manualMapping;
    method = 'MANUAL';
    confidence = 1;
    headerRow = fields.headerRow !== undefined ? Number(fields.headerRow) : (fixedHeaderRow ?? detectMapping(rows).headerRow);
    headers = headerRow >= 0 ? rows[headerRow] ?? [] : [];
  } else if (fixedMapping) {
    mapping = fixedMapping;
    method = 'HEADER';
    confidence = 0.7;
    headerRow = fixedHeaderRow ?? 0;
    headers = rows[headerRow] ?? [];
  } else {
    const d = detectMapping(rows, dayFirstOverride ?? true);
    mapping = d.mapping;
    method = d.method;
    confidence = d.confidence;
    headerRow = fields.headerRow !== undefined ? Number(fields.headerRow) : d.headerRow;
    headers = d.headers;
    warnings.push(...d.warnings);
  }
  if (mapping.date === undefined || (mapping.debit === undefined && mapping.credit === undefined && mapping.amount === undefined)) {
    throw new BusinessRuleError('The columns of this statement were not recognised. Choose which column is the Date and the Debit / Credit amounts.', {
      code: 'MAPPING_REQUIRED', sampleRows: rows.slice(0, 25), totalRows: rows.length,
    });
  }

  const hints: BalanceHints = pdfHints ?? scanBalanceHints(rows);
  if (fields.opening !== undefined) hints.opening = money2(D(fields.opening));
  if (fields.closing !== undefined) hints.closing = money2(D(fields.closing));

  const dateSamples = rows.slice(Math.max(0, headerRow + 1), headerRow + 400).map((r) => r[mapping.date!] ?? '');
  const dayFirst = dayFirstOverride ?? detectDayFirst(dateSamples);
  const normalised = rowsToLines(rows, headerRow, mapping, { dayFirst, opening: hints.opening });
  if (normalised.lines.length === 0) {
    throw new BusinessRuleError('No transactions could be read with these columns. Check the Date and amount columns.', {
      code: 'MAPPING_REQUIRED', sampleRows: rows.slice(0, 25), totalRows: rows.length,
    });
  }
  // A row that has a date but no readable amount is a transaction we could not read: never drop it silently
  const unreadable = normalised.skipped.filter((s) => s.reason === 'NO_AMOUNT').length;
  if (unreadable > 0) warnings.push(`ROWS_WITHOUT_AMOUNT:${unreadable}`);
  if (normalised.lines.some((l) => l.flags.includes('DIRECTION_GUESSED'))) warnings.push('DIRECTION_GUESSED');
  if (normalised.lines.some((l) => l.flags.includes('BOTH_SIDES'))) warnings.push('BOTH_DEBIT_AND_CREDIT_ON_A_LINE');

  const lines = assignHashes(normalised.lines);
  const balanceCheck = verifyBalanceChain(lines, hints);
  const dates = lines.map((l) => l.txnDate).sort();
  return {
    source, fileHash, headers, headerRow, mapping, method, mappingConfidence: confidence, dayFirst,
    lines, skippedRows: normalised.skipped.length, hints, balanceCheck,
    periodStart: dates[0] ?? null, periodEnd: dates[dates.length - 1] ?? null,
    warnings, sampleRows: rows.slice(0, 25), totalRows: rows.length,
  };
}

// ─── PREVIEW / IMPORT ───────────────────────────────────────────────────────

async function existingHashes(accountId: string, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += 1000) {
    const rows = await db.select({ hash: bankStatementLines.hash }).from(bankStatementLines)
      .where(and(eq(bankStatementLines.accountId, accountId), inArray(bankStatementLines.hash, hashes.slice(i, i + 1000))));
    rows.forEach((r) => found.add(r.hash));
  }
  return found;
}

export async function previewStatement(user: JwtPayload, accountId: string, buf: Buffer, fields: UploadFields) {
  const account = await loadAccount(user, accountId);
  const parsed = await parseStatementFile(buf, fields);
  const dup = await existingHashes(account.id, parsed.lines.map((l) => l.hash));
  const [sameFile] = await db.select({ id: bankStatements.id }).from(bankStatements)
    .where(and(eq(bankStatements.accountId, account.id), eq(bankStatements.fileHash, parsed.fileHash))).limit(1);
  return {
    ...parsed,
    // Large statements: the screen only needs a window of parsed lines (the rest are summarised)
    lines: parsed.lines.slice(0, 200),
    lineCount: parsed.lines.length,
    duplicateLines: dup.size,
    newLines: parsed.lines.length - dup.size,
    alreadyImported: Boolean(sameFile),
    existingStatementId: sameFile?.id ?? null,
  };
}

export async function importStatement(user: JwtPayload, accountId: string, buf: Buffer, fields: UploadFields, filename: string | null) {
  const account = await loadAccount(user, accountId);
  const parsed = await parseStatementFile(buf, fields);

  const [sameFile] = await db.select({ id: bankStatements.id }).from(bankStatements)
    .where(and(eq(bankStatements.accountId, account.id), eq(bankStatements.fileHash, parsed.fileHash))).limit(1);
  if (sameFile) throw new ConflictError('This exact file has already been imported for this account', { existingStatementId: sameFile.id });

  if (parsed.balanceCheck.status === 'FAIL' && fields.acceptBalanceMismatch !== 'true') {
    throw new BusinessRuleError(
      `Not imported: ${parsed.balanceCheck.message} Fix the column mapping or the file, or confirm to import it anyway.`,
      { code: 'BALANCE_MISMATCH', balanceCheck: parsed.balanceCheck },
    );
  }

  const dup = await existingHashes(account.id, parsed.lines.map((l) => l.hash));
  const fresh = parsed.lines.filter((l) => !dup.has(l.hash));
  const closing = parsed.balanceCheck.closing;

  const statement = await db.transaction(async (tx) => {
    const [st] = await tx.insert(bankStatements).values({
      accountId: account.id, uploadedById: user.sub, originalFilename: filename?.slice(0, 200) ?? null,
      fileHash: parsed.fileHash, source: parsed.source,
      periodStart: parsed.periodStart, periodEnd: parsed.periodEnd,
      openingBalance: parsed.balanceCheck.opening, closingBalance: closing,
      lineCount: fresh.length, duplicateCount: dup.size,
      balanceCheck: parsed.balanceCheck as unknown as Record<string, unknown>,
      mapping: { ...parsed.mapping, method: parsed.method, headerRow: parsed.headerRow, dayFirst: parsed.dayFirst },
      warnings: parsed.warnings,
    }).returning();
    for (let i = 0; i < fresh.length; i += 500) {
      await tx.insert(bankStatementLines).values(fresh.slice(i, i + 500).map((l) => ({
        statementId: st.id, accountId: account.id, lineNo: l.lineNo, txnDate: l.txnDate, valueDate: l.valueDate,
        narration: l.narration.slice(0, 500), reference: l.reference?.slice(0, 120) ?? null,
        debit: l.debit, credit: l.credit, balance: l.balance, hash: l.hash, confidence: String(l.confidence.toFixed(3)),
      })));
    }
    return st;
  });
  await logAudit(user.sub, 'bank.statement.import', { type: 'bank_statement', id: statement.id }, {
    accountId: account.id, lines: fresh.length, duplicates: dup.size, balanceCheck: parsed.balanceCheck.status,
  });

  const matched = fresh.length > 0 ? await runAutoMatch(user, statement.id) : { suggested: 0, unmatched: 0, autoIgnored: 0 };
  return { statement, imported: fresh.length, duplicates: dup.size, balanceCheck: parsed.balanceCheck, warnings: parsed.warnings, match: matched };
}

// ─── BOOK SIDE ──────────────────────────────────────────────────────────────

interface BookRow extends BookEntry { branchId: string }

// A BILL_VOID reversal sits on the opposite side of its sale but belongs to the same settlement group
const isSalesNet = (e: BookRow) => e.sourceType === 'BILL' || e.sourceType === 'BILL_VOID';

/** BANK-ledger entries of the account's books that no statement line accounts for yet. */
async function loadUnmatchedBookEntries(account: Account, from: string, to: string): Promise<BookRow[]> {
  const branchIds = await scopeBranchIds(account);
  const rows = await db
    .select({
      id: journalLines.id, date: journalVouchers.voucherDate, debit: journalLines.debit, credit: journalLines.credit,
      narration: journalVouchers.narration, sourceType: journalVouchers.sourceType, branchId: journalVouchers.branchId,
    })
    .from(journalLines)
    .innerJoin(journalVouchers, eq(journalLines.voucherId, journalVouchers.id))
    .innerJoin(accountLedgers, eq(journalLines.ledgerId, accountLedgers.id))
    .where(and(
      eq(accountLedgers.code, 'BANK'),
      inArray(accountLedgers.branchId, branchIds),
      gte(journalVouchers.voucherDate, from),
      lte(journalVouchers.voucherDate, to),
      sql`not exists (select 1 from ${bankLineMatches} where ${bankLineMatches.journalLineId} = ${journalLines.id})`,
    ))
    .orderBy(asc(journalVouchers.voucherDate));
  return rows;
}

// ─── AUTO-MATCH ─────────────────────────────────────────────────────────────

const toEngineRule = (r: typeof bankIgnoreRules.$inferSelect): IgnoreRule => ({
  id: r.id, pattern: r.pattern, side: r.side as IgnoreRule['side'], minAmount: r.minAmount, maxAmount: r.maxAmount,
  reason: r.reason as IgnoreReason, action: r.action as IgnoreRule['action'], isActive: r.isActive,
});

export async function runAutoMatch(user: JwtPayload, statementId: string): Promise<{ suggested: number; unmatched: number; autoIgnored: number }> {
  const { account } = await loadStatement(user, statementId);
  const open = await db.select().from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, statementId), inArray(bankStatementLines.status, ['UNMATCHED', 'SUGGESTED'])));
  if (open.length === 0) return { suggested: 0, unmatched: 0, autoIgnored: 0 };

  const dates = open.map((l) => l.txnDate).sort();
  const entries = await loadUnmatchedBookEntries(account, addDays(dates[0], -12), addDays(dates[dates.length - 1], 8));
  const suggestions = suggestMatches(
    open.map((l) => ({ id: l.id, date: l.txnDate, debit: l.debit, credit: l.credit, narration: l.narration, reference: l.reference })),
    entries,
  );
  const rules = (await db.select().from(bankIgnoreRules)
    .where(and(eq(bankIgnoreRules.accountId, account.id), eq(bankIgnoreRules.isActive, true)))
    .orderBy(asc(bankIgnoreRules.createdAt))).map(toEngineRule);

  let suggested = 0;
  let autoIgnored = 0;
  const autoRuleIds = new Set<string>();
  await db.transaction(async (tx) => {
    for (const l of open) {
      let s: Suggestion | null = suggestions.get(l.id) ?? null;
      // A rule may only take a line the books have no answer for. Something that matches a book entry is never hidden.
      // …and never a line a person has deliberately taken back (un-ignored): that decision sticks.
      const rule = (!s || s.kind === 'POST') && !l.ruleExempt ? matchIgnoreRule(l, rules) : null;
      if (rule?.action === 'AUTO') {
        await tx.update(bankStatementLines).set({
          status: 'IGNORED', ignoreReason: rule.reason, ignoredByRuleId: rule.id, note: `Ignored by rule “${rule.pattern}”`,
          suggestion: null, confidence: null, resolvedById: null, resolvedAt: new Date(),
        }).where(eq(bankStatementLines.id, l.id));
        autoIgnored++;
        autoRuleIds.add(rule.id);
        continue;
      }
      if (rule) {
        s = {
          kind: 'IGNORE', ruleId: rule.id, pattern: rule.pattern, ignoreReason: rule.reason, confidence: 0.7,
          reason: `Matches your ignore rule “${rule.pattern}” (${REASON_LABEL[rule.reason].toLowerCase()}). Confirm to ignore it.`,
        };
      }
      if (s) suggested++;
      await tx.update(bankStatementLines).set({
        status: s ? 'SUGGESTED' : 'UNMATCHED',
        suggestion: s as unknown as Record<string, unknown> | null,
        confidence: s ? String(s.confidence.toFixed(3)) : null,
      }).where(eq(bankStatementLines.id, l.id));
    }
  });
  if (autoIgnored > 0) {
    await logAudit(user.sub, 'bank.line.auto_ignore', { type: 'bank_statement', id: statementId }, { count: autoIgnored, ruleIds: [...autoRuleIds] });
  }
  return { suggested, unmatched: open.length - suggested - autoIgnored, autoIgnored };
}

// ─── IGNORE RULES ───────────────────────────────────────────────────────────

export async function listRules(user: JwtPayload, accountId: string) {
  await loadAccount(user, accountId);
  const rules = await db.select().from(bankIgnoreRules).where(eq(bankIgnoreRules.accountId, accountId)).orderBy(asc(bankIgnoreRules.createdAt));
  const hits = await db.select({ ruleId: bankStatementLines.ignoredByRuleId, n: sql<number>`count(*)::int` }).from(bankStatementLines)
    .where(and(eq(bankStatementLines.accountId, accountId), sql`${bankStatementLines.ignoredByRuleId} is not null`))
    .groupBy(bankStatementLines.ignoredByRuleId);
  return rules.map((r) => ({ ...r, ignoredLines: hits.find((h) => h.ruleId === r.id)?.n ?? 0 }));
}

async function insertRule(accountId: string, userId: string, input: z.infer<typeof RuleBodySchema> & { reason: IgnoreReason }) {
  const [dup] = await db.select({ id: bankIgnoreRules.id }).from(bankIgnoreRules)
    .where(and(eq(bankIgnoreRules.accountId, accountId), sql`lower(${bankIgnoreRules.pattern}) = ${input.pattern.toLowerCase()}`, eq(bankIgnoreRules.side, input.side))).limit(1);
  if (dup) throw new ConflictError('There is already a rule for this text');
  const [row] = await db.insert(bankIgnoreRules).values({
    accountId, pattern: input.pattern, side: input.side, minAmount: input.minAmount ?? null, maxAmount: input.maxAmount ?? null,
    reason: input.reason, action: input.action, createdById: userId,
  }).returning();
  await logAudit(userId, 'bank.rule.create', { type: 'bank_ignore_rule', id: row.id }, { accountId, pattern: row.pattern, action: row.action, reason: row.reason });
  return row;
}

export async function createRule(user: JwtPayload, accountId: string, input: z.infer<typeof CreateRuleSchema>) {
  await loadAccount(user, accountId);
  return insertRule(accountId, user.sub, input);
}

async function loadRule(user: JwtPayload, id: string) {
  const [rule] = await db.select().from(bankIgnoreRules).where(eq(bankIgnoreRules.id, id)).limit(1);
  if (!rule) throw new NotFoundError('Rule not found');
  await loadAccount(user, rule.accountId);
  return rule;
}

export async function updateRule(user: JwtPayload, id: string, input: z.infer<typeof UpdateRuleSchema>) {
  const rule = await loadRule(user, id);
  const patch: Partial<typeof bankIgnoreRules.$inferInsert> = {};
  if (input.pattern !== undefined) patch.pattern = input.pattern;
  if (input.side !== undefined) patch.side = input.side;
  if (input.minAmount !== undefined) patch.minAmount = input.minAmount;
  if (input.maxAmount !== undefined) patch.maxAmount = input.maxAmount;
  if (input.reason !== undefined) patch.reason = input.reason;
  if (input.action !== undefined) patch.action = input.action;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (Object.keys(patch).length === 0) throw new BusinessRuleError('Nothing to update');
  const lo = patch.minAmount === undefined ? rule.minAmount : patch.minAmount;
  const hi = patch.maxAmount === undefined ? rule.maxAmount : patch.maxAmount;
  if (lo !== null && hi !== null && D(lo).gt(hi)) throw new BusinessRuleError('The smallest amount is above the largest');
  const [row] = await db.update(bankIgnoreRules).set(patch).where(eq(bankIgnoreRules.id, id)).returning();
  await logAudit(user.sub, 'bank.rule.update', { type: 'bank_ignore_rule', id }, { ...patch });
  return row;
}

/** Deleting a rule stops future matching. Lines it already ignored stay ignored (they are decisions on record). */
export async function deleteRule(user: JwtPayload, id: string) {
  const rule = await loadRule(user, id);
  await db.delete(bankIgnoreRules).where(eq(bankIgnoreRules.id, id));
  await logAudit(user.sub, 'bank.rule.delete', { type: 'bank_ignore_rule', id }, { accountId: rule.accountId, pattern: rule.pattern });
  return { deleted: true };
}

// ─── RESOLVING A LINE ───────────────────────────────────────────────────────

const lineAmount = (l: Line) => (D(l.credit).gt(0) ? D(l.credit) : D(l.debit));
const lineSide = (l: Line): 'IN' | 'OUT' => (D(l.credit).gt(0) ? 'IN' : 'OUT');

function assertOpen(line: Line): void {
  if (line.status === 'MATCHED') throw new ConflictError('This line is already matched');
  if (line.status === 'IGNORED') throw new ConflictError('This line is ignored. Un-ignore it first');
}

/** Posts a voucher from a statement line and links its BANK entry to the line. Returns the voucher id. */
async function postVoucherForLine(
  tx: Tx, account: Account, line: Line, user: JwtPayload,
  spec: { voucherType: 'CONTRA' | 'PAYMENT' | 'RECEIPT'; lines: Array<{ ledger: string; debit: string; credit: string }> },
  narration: string, otherLedgerId?: string,
): Promise<string> {
  const ids = await ensureSystemLedgers(tx, account.branchId);
  const lines = spec.lines.map((l) => {
    const ledger = l.ledger === '__OTHER__' ? otherLedgerId : ids.get(l.ledger);
    if (!ledger) throw new BusinessRuleError(`Ledger ${l.ledger} is not available for this branch`);
    return { ledger, debit: l.debit, credit: l.credit };
  });
  const posted = await insertVoucher(tx, {
    branchId: account.branchId, voucherDate: line.txnDate, voucherType: spec.voucherType, narration: narration.slice(0, 250),
    sourceType: 'BANK_LINE', sourceId: line.id, createdById: user.sub,
  }, lines);
  if (!posted) throw new ConflictError('A voucher has already been posted for this line');
  const bankLedgerId = ids.get('BANK')!;
  const bankLine = posted.lines.find((l) => l.ledgerId === bankLedgerId);
  if (!bankLine) throw new Error('Posted voucher has no BANK entry');
  await tx.insert(bankLineMatches).values({ lineId: line.id, journalLineId: bankLine.id });
  return posted.voucher.id;
}

async function linkEntries(tx: Tx, lineId: string, entryIds: string[]): Promise<void> {
  try {
    await tx.insert(bankLineMatches).values(entryIds.map((journalLineId) => ({ lineId, journalLineId })));
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A book entry in this match was already matched to another line. Re-run matching.');
    throw err;
  }
}

async function loadEntriesForMatch(tx: Tx, account: Account, entryIds: string[]): Promise<BookRow[]> {
  const branchIds = await scopeBranchIds(account);
  const rows = await tx
    .select({
      id: journalLines.id, date: journalVouchers.voucherDate, debit: journalLines.debit, credit: journalLines.credit,
      narration: journalVouchers.narration, sourceType: journalVouchers.sourceType, branchId: journalVouchers.branchId,
    })
    .from(journalLines)
    .innerJoin(journalVouchers, eq(journalLines.voucherId, journalVouchers.id))
    .innerJoin(accountLedgers, eq(journalLines.ledgerId, accountLedgers.id))
    .where(and(inArray(journalLines.id, entryIds), eq(accountLedgers.code, 'BANK'), inArray(accountLedgers.branchId, branchIds)));
  if (rows.length !== new Set(entryIds).size) throw new BusinessRuleError('Some of those book entries do not exist, or belong to a different account');
  // Say so plainly when an entry is already reconciled, before any amount arithmetic produces a confusing message
  const taken = await tx.select({ id: bankLineMatches.journalLineId }).from(bankLineMatches).where(inArray(bankLineMatches.journalLineId, entryIds));
  if (taken.length > 0) throw new ConflictError('A book entry in this match is already reconciled with another statement line.');
  return rows;
}

/**
 * Links a statement line to book entries. If the book total differs from the statement amount the gap is a fee
 * (a settlement paid out less than the sales, or the bank took an extra charge); it is posted as a bank charge
 * when `postFee` is set, otherwise the match is refused.
 */
async function applyMatch(
  tx: Tx, account: Account, line: Line, user: JwtPayload, entryIds: string[],
  opts: { category: string; postFee: boolean },
): Promise<{ fee: Decimal; voucherId: string | null }> {
  const entries = await loadEntriesForMatch(tx, account, entryIds);
  const side = lineSide(line);
  // Every entry must run the same way as the line (a sale reversal inside a settlement group is the one exception)
  if (entries.some((e) => !(side === 'IN' ? D(e.debit).gt(0) : D(e.credit).gt(0)) && !isSalesNet(e))) {
    throw new BusinessRuleError('A book entry runs in the opposite direction to this statement line');
  }
  const bookTotal = entries.reduce((a, e) => a.plus(side === 'IN' ? D(e.debit).minus(e.credit) : D(e.credit).minus(e.debit)), D(0));
  const amount = lineAmount(line);
  const fee = side === 'IN' ? bookTotal.minus(amount) : amount.minus(bookTotal);   // positive = the bank kept / took more
  if (fee.lt(TOL.negated())) {
    throw new BusinessRuleError(`The statement shows ₹${money2(amount)} but those book entries total only ₹${money2(bookTotal)}. Post the extra ₹${money2(fee.negated())} separately.`);
  }
  if (fee.gt(bookTotal.abs().mul('0.15')) && fee.gt(10)) {
    throw new BusinessRuleError(`The difference of ₹${money2(fee)} is too large to be a fee. Check you selected the right entries.`);
  }
  const hasFee = fee.gt(TOL);
  if (hasFee && !opts.postFee) {
    throw new BusinessRuleError(`The amounts differ by ₹${money2(fee)}. Confirm posting it as a bank charge, or choose different entries.`);
  }
  await linkEntries(tx, line.id, entries.map((e) => e.id));
  let voucherId: string | null = null;
  if (hasFee) {
    voucherId = await postVoucherForLine(tx, account, line, user,
      { voucherType: 'PAYMENT', lines: feePosting(money2(fee)) },
      `Bank/gateway fee withheld: ${line.narration || 'statement line'}`);
  }
  await tx.update(bankStatementLines).set({
    status: 'MATCHED', category: opts.category, feeAmount: money2(hasFee ? fee : D(0)), voucherId,
    resolvedById: user.sub, resolvedAt: new Date(),
  }).where(eq(bankStatementLines.id, line.id));
  return { fee: hasFee ? fee : D(0), voucherId };
}
export async function acceptSuggestion(user: JwtPayload, lineId: string, input: z.infer<typeof AcceptSchema> = {}) {
  const { line, account } = await loadLine(user, lineId);
  assertOpen(line);
  const s = line.suggestion as unknown as Suggestion | null;
  if (!s || (s.kind !== 'ONE_TO_ONE' && s.kind !== 'SETTLEMENT')) {
    throw new BusinessRuleError('This line has no match suggestion to accept. Post it or match it manually.');
  }
  const result = await db.transaction((tx) => applyMatch(tx, account, line, user, s.entryIds, {
    category: s.kind === 'SETTLEMENT' ? 'SETTLEMENT' : 'BOOK_MATCH',
    postFee: s.kind === 'SETTLEMENT' ? input.postFee !== false : false,
  }));
  await logAudit(user.sub, 'bank.line.accept', { type: 'bank_statement_line', id: line.id }, { kind: s.kind, entries: s.entryIds.length, fee: money2(result.fee) });
  return { status: 'MATCHED', fee: money2(result.fee), voucherId: result.voucherId };
}

export async function acceptSuggestions(user: JwtPayload, statementId: string, minConfidence = 0.85) {
  await loadStatement(user, statementId);   // authorises access to the statement's account
  const rows = await db.select().from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.status, 'SUGGESTED')));
  let accepted = 0;
  const skipped: { lineId: string; reason: string }[] = [];
  for (const l of rows) {
    const s = l.suggestion as unknown as Suggestion | null;
    if (!s || (s.kind !== 'ONE_TO_ONE' && s.kind !== 'SETTLEMENT')) continue;
    if (s.confidence < minConfidence) { skipped.push({ lineId: l.id, reason: 'LOW_CONFIDENCE' }); continue; }
    try { await acceptSuggestion(user, l.id); accepted++; }
    catch (err) { skipped.push({ lineId: l.id, reason: err instanceof Error ? err.message : 'FAILED' }); }
  }
  return { accepted, skipped: skipped.length, details: skipped.slice(0, 20) };
}

export async function manualMatch(user: JwtPayload, lineId: string, input: z.infer<typeof ManualMatchSchema>) {
  const { line, account } = await loadLine(user, lineId);
  assertOpen(line);
  const result = await db.transaction((tx) => applyMatch(tx, account, line, user, input.entryIds, { category: 'BOOK_MATCH', postFee: input.postDifference === true }));
  await logAudit(user.sub, 'bank.line.match', { type: 'bank_statement_line', id: line.id }, { entries: input.entryIds.length, fee: money2(result.fee) });
  return { status: 'MATCHED', fee: money2(result.fee), voucherId: result.voucherId };
}

export async function postLine(user: JwtPayload, lineId: string, input: z.infer<typeof PostLineSchema>) {
  const { line, account } = await loadLine(user, lineId);
  assertOpen(line);
  const side = lineSide(line);
  if (CATEGORY_SIDE[input.category] !== side) {
    throw new BusinessRuleError(`${input.category.replace(/_/g, ' ').toLowerCase()} cannot be used for a ${side === 'IN' ? 'credit (money in)' : 'debit (money out)'} line`);
  }
  const spec = postingForCategory(input.category, money2(lineAmount(line)));
  let otherLedgerId: string | undefined;
  if (spec.lines.some((l) => l.ledger === '__OTHER__')) {
    if (!input.ledgerId) throw new BusinessRuleError('Choose the ledger account this belongs to');
    const [ledger] = await db.select({ id: accountLedgers.id, branchId: accountLedgers.branchId, code: accountLedgers.code })
      .from(accountLedgers).where(eq(accountLedgers.id, input.ledgerId)).limit(1);
    if (!ledger || ledger.branchId !== account.branchId) throw new BusinessRuleError('That ledger does not belong to this account\'s books');
    if (ledger.code === 'BANK') throw new BusinessRuleError('Choose the other side of the entry, not the bank ledger itself');
    otherLedgerId = ledger.id;
  }
  const narration = input.narration || `Bank: ${line.narration || input.category}`;
  const voucherId = await db.transaction(async (tx) => {
    const vid = await postVoucherForLine(tx, account, line, user, spec, narration, otherLedgerId);
    await tx.update(bankStatementLines).set({
      status: 'MATCHED', category: input.category, voucherId: vid, feeAmount: '0.00', resolvedById: user.sub, resolvedAt: new Date(),
    }).where(eq(bankStatementLines.id, line.id));
    return vid;
  });
  await logAudit(user.sub, 'bank.line.post', { type: 'bank_statement_line', id: line.id }, { category: input.category, amount: money2(lineAmount(line)), voucherId });
  return { status: 'MATCHED', voucherId };
}

async function ruleFor(account: Account, ruleId: string | undefined): Promise<string | null> {
  if (!ruleId) return null;
  const [r] = await db.select({ id: bankIgnoreRules.id }).from(bankIgnoreRules)
    .where(and(eq(bankIgnoreRules.id, ruleId), eq(bankIgnoreRules.accountId, account.id))).limit(1);
  return r?.id ?? null;
}

export async function ignoreLine(user: JwtPayload, lineId: string, input: z.infer<typeof IgnoreSchema>) {
  const { line, statement, account } = await loadLine(user, lineId);
  assertOpen(line);
  await db.update(bankStatementLines).set({
    status: 'IGNORED', ignoreReason: input.reason, note: input.note ?? null, ignoredByRuleId: await ruleFor(account, input.ruleId),
    suggestion: null, confidence: null, resolvedById: user.sub, resolvedAt: new Date(),
  }).where(eq(bankStatementLines.id, line.id));
  await logAudit(user.sub, 'bank.line.ignore', { type: 'bank_statement_line', id: line.id }, { reason: input.reason, note: input.note ?? null });

  // "Ignore lines like this from now on": save the rule, then let it work on the other open lines straight away
  let rule: { id: string; applied: { autoIgnored: number; suggested: number } } | null = null;
  if (input.rule) {
    const created = await insertRule(account.id, user.sub, { ...input.rule, reason: input.reason });
    const r = await runAutoMatch(user, statement.id);
    rule = { id: created.id, applied: { autoIgnored: r.autoIgnored, suggested: r.suggested } };
  }
  return { status: 'IGNORED', rule };
}

/** Ignore many lines at once (a month of personal spend). Only lines of this statement that are still open are touched. */
export async function ignoreBulk(user: JwtPayload, statementId: string, input: z.infer<typeof BulkIgnoreSchema>) {
  const { account } = await loadStatement(user, statementId);
  const ids = [...new Set(input.lineIds)];
  const rows = await db.select({ id: bankStatementLines.id }).from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, statementId), inArray(bankStatementLines.id, ids), inArray(bankStatementLines.status, ['UNMATCHED', 'SUGGESTED'])));
  if (rows.length > 0) {
    await db.update(bankStatementLines).set({
      status: 'IGNORED', ignoreReason: input.reason, note: input.note ?? null, ignoredByRuleId: null,
      suggestion: null, confidence: null, resolvedById: user.sub, resolvedAt: new Date(),
    }).where(inArray(bankStatementLines.id, rows.map((r) => r.id)));
    await logAudit(user.sub, 'bank.line.ignore_bulk', { type: 'bank_statement', id: statementId }, { count: rows.length, reason: input.reason, note: input.note ?? null });
  }
  let rule: { id: string; applied: { autoIgnored: number; suggested: number } } | null = null;
  if (input.rule) {
    const created = await insertRule(account.id, user.sub, { ...input.rule, reason: input.reason });
    const r = await runAutoMatch(user, statementId);
    rule = { id: created.id, applied: { autoIgnored: r.autoIgnored, suggested: r.suggested } };
  }
  return { ignored: rows.length, skipped: ids.length - rows.length, rule };
}

/** Confirms every "ignore (rule)" suggestion on the statement in one go. Book matches and postings are never touched. */
export async function applyIgnoreSuggestions(user: JwtPayload, statementId: string) {
  const { account } = await loadStatement(user, statementId);
  const rows = await db.select().from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.status, 'SUGGESTED')));
  let ignored = 0;
  for (const l of rows) {
    const s = l.suggestion as unknown as Suggestion | null;
    if (!s || s.kind !== 'IGNORE') continue;
    await db.update(bankStatementLines).set({
      status: 'IGNORED', ignoreReason: s.ignoreReason, note: `Confirmed rule “${s.pattern}”`, ignoredByRuleId: await ruleFor(account, s.ruleId),
      suggestion: null, confidence: null, resolvedById: user.sub, resolvedAt: new Date(),
    }).where(eq(bankStatementLines.id, l.id));
    ignored++;
  }
  if (ignored > 0) await logAudit(user.sub, 'bank.line.ignore_confirm_rules', { type: 'bank_statement', id: statementId }, { count: ignored });
  return { ignored };
}

export async function unmatchLine(user: JwtPayload, lineId: string) {
  const { line } = await loadLine(user, lineId);
  if (line.status !== 'MATCHED' && line.status !== 'IGNORED') throw new BusinessRuleError('This line is not matched or ignored');
  if (line.voucherId) {
    throw new ConflictError('Accepting this line posted a voucher. Reverse that voucher with a manual journal entry; the line cannot simply be un-matched.');
  }
  await db.transaction(async (tx) => {
    await tx.delete(bankLineMatches).where(eq(bankLineMatches.lineId, line.id));
    await tx.update(bankStatementLines).set({
      status: 'UNMATCHED', category: null, suggestion: null, confidence: null, feeAmount: '0.00', note: null, ignoreReason: null, ignoredByRuleId: null,
      resolvedById: null, resolvedAt: null,
      // Taking back an ignored line is a decision: rules must not quietly ignore it again on the next match run
      ...(line.status === 'IGNORED' ? { ruleExempt: true } : {}),
    }).where(eq(bankStatementLines.id, line.id));
  });
  await logAudit(user.sub, 'bank.line.unmatch', { type: 'bank_statement_line', id: line.id });
  return { status: 'UNMATCHED' };
}

/** Unmatched book entries near a line, for picking a match by hand. */
export async function listCandidates(user: JwtPayload, lineId: string) {
  const { line, account } = await loadLine(user, lineId);
  const side = lineSide(line);
  const entries = await loadUnmatchedBookEntries(account, addDays(line.txnDate, -20), addDays(line.txnDate, 10));
  return entries
    .filter((e) => (side === 'IN' ? D(e.debit).gt(0) : D(e.credit).gt(0)) || isSalesNet(e))
    .slice(0, 300)
    .map((e) => ({ id: e.id, date: e.date, debit: e.debit, credit: e.credit, narration: e.narration, sourceType: e.sourceType }));
}

// ─── QUERIES ────────────────────────────────────────────────────────────────

export async function listStatements(user: JwtPayload, accountId: string) {
  const account = await loadAccount(user, accountId);
  const rows = await db.select().from(bankStatements).where(eq(bankStatements.accountId, account.id)).orderBy(desc(bankStatements.createdAt));
  if (rows.length === 0) return [];
  const counts = await db.select({
    statementId: bankStatementLines.statementId, status: bankStatementLines.status, n: sql<number>`count(*)::int`,
  }).from(bankStatementLines).where(inArray(bankStatementLines.statementId, rows.map((r) => r.id)))
    .groupBy(bankStatementLines.statementId, bankStatementLines.status);
  return rows.map((s) => ({
    ...s,
    counts: Object.fromEntries(counts.filter((c) => c.statementId === s.id).map((c) => [c.status, c.n])) as Record<string, number>,
  }));
}

export async function getStatement(user: JwtPayload, id: string) {
  const { statement, account } = await loadStatement(user, id);
  const counts = await db.select({ status: bankStatementLines.status, n: sql<number>`count(*)::int` })
    .from(bankStatementLines).where(eq(bankStatementLines.statementId, id)).groupBy(bankStatementLines.status);
  return { statement, account, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number> };
}

export async function listLines(user: JwtPayload, statementId: string, q: z.infer<typeof LinesQuerySchema>) {
  await loadStatement(user, statementId);
  const search = q.search ? `%${q.search.replace(/[%_\\]/g, '\\$&')}%` : null;
  const rows = await db.select().from(bankStatementLines)
    .where(and(
      eq(bankStatementLines.statementId, statementId),
      q.status ? eq(bankStatementLines.status, q.status) : undefined,
      search ? sql`(${bankStatementLines.narration} ilike ${search} or ${bankStatementLines.reference} ilike ${search})` : undefined,
    ))
    .orderBy(asc(bankStatementLines.lineNo))
    .limit(q.limit).offset(q.offset);
  // A starting point for "ignore lines like this" (the merchant/person in the narration), so the user rarely has to type one
  return rows.map((r) => ({ ...r, suggestedPattern: suggestPattern(r.narration) }));
}

export async function deleteStatement(user: JwtPayload, id: string) {
  await loadStatement(user, id);
  const [posted] = await db.select({ id: bankStatementLines.id }).from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, id), sql`${bankStatementLines.voucherId} is not null`)).limit(1);
  if (posted) throw new ConflictError('This statement has lines that posted vouchers to the books, so it cannot be deleted. Reverse those vouchers first.');
  await db.delete(bankStatements).where(eq(bankStatements.id, id));   // lines and matches cascade
  await logAudit(user.sub, 'bank.statement.delete', { type: 'bank_statement', id });
  return { deleted: true };
}

export async function finalizeStatement(user: JwtPayload, id: string) {
  await loadStatement(user, id);
  const open = await db.select({ n: sql<number>`count(*)::int` }).from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, id), inArray(bankStatementLines.status, ['UNMATCHED', 'SUGGESTED'])));
  const n = open[0]?.n ?? 0;
  if (n > 0) throw new BusinessRuleError(`${n} line(s) are still unmatched or only suggested. Resolve them (match, post or ignore) first.`);
  await db.update(bankStatements).set({ status: 'RECONCILED' }).where(eq(bankStatements.id, id));
  await logAudit(user.sub, 'bank.statement.finalize', { type: 'bank_statement', id });
  return { status: 'RECONCILED' };
}

/** Bank reconciliation statement as at the end of the statement's period. */
export async function getSummary(user: JwtPayload, statementId: string) {
  const { statement, account } = await loadStatement(user, statementId);
  const asAt = statement.periodEnd ?? new Date().toISOString().slice(0, 10);
  const branchIds = await scopeBranchIds(account);

  const [opening] = await db.select({ v: sql<string>`coalesce(sum(${accountLedgers.openingBalance}), 0)` }).from(accountLedgers)
    .where(and(eq(accountLedgers.code, 'BANK'), inArray(accountLedgers.branchId, branchIds)));
  const [movement] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
    .from(journalLines)
    .innerJoin(journalVouchers, eq(journalLines.voucherId, journalVouchers.id))
    .innerJoin(accountLedgers, eq(journalLines.ledgerId, accountLedgers.id))
    .where(and(eq(accountLedgers.code, 'BANK'), inArray(accountLedgers.branchId, branchIds), lte(journalVouchers.voucherDate, asAt)));
  const bookBalance = D(opening?.v ?? 0).plus(movement?.v ?? 0);

  const outstanding = await loadUnmatchedBookEntries(account, '1990-01-01', asAt);
  const outReceipts = outstanding.reduce((a, e) => a.plus(e.debit), D(0));
  const outPayments = outstanding.reduce((a, e) => a.plus(e.credit), D(0));

  const sums = await db.select({
    status: bankStatementLines.status,
    credit: sql<string>`coalesce(sum(${bankStatementLines.credit}), 0)`,
    debit: sql<string>`coalesce(sum(${bankStatementLines.debit}), 0)`,
  }).from(bankStatementLines)
    .where(and(eq(bankStatementLines.accountId, account.id), lte(bankStatementLines.txnDate, asAt)))
    .groupBy(bankStatementLines.status);
  const pick = (statuses: string[]) => sums.filter((s) => statuses.includes(s.status));
  const unposted = pick(['UNMATCHED', 'SUGGESTED']);
  const ignored = pick(['IGNORED']);

  const summary = summarise({
    bankClosing: statement.closingBalance,
    bookBalance: money2(bookBalance),
    outstandingReceipts: money2(outReceipts),
    outstandingPayments: money2(outPayments),
    unpostedReceipts: money2(unposted.reduce((a, s) => a.plus(s.credit), D(0))),
    unpostedPayments: money2(unposted.reduce((a, s) => a.plus(s.debit), D(0))),
    ignoredNet: money2(ignored.reduce((a, s) => a.plus(s.credit).minus(s.debit), D(0))),
  });
  const counts = await db.select({ status: bankStatementLines.status, n: sql<number>`count(*)::int` })
    .from(bankStatementLines).where(eq(bankStatementLines.statementId, statementId)).groupBy(bankStatementLines.status);

  // What was left out of the books on purpose, and why (this statement)
  const ign = await db.select({
    reason: bankStatementLines.ignoreReason,
    n: sql<number>`count(*)::int`,
    credit: sql<string>`coalesce(sum(${bankStatementLines.credit}), 0)`,
    debit: sql<string>`coalesce(sum(${bankStatementLines.debit}), 0)`,
  }).from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.status, 'IGNORED')))
    .groupBy(bankStatementLines.ignoreReason);
  const ignoredSummary = {
    count: ign.reduce((a, r) => a + r.n, 0),
    totalIn: money2(ign.reduce((a, r) => a.plus(r.credit), D(0))),
    totalOut: money2(ign.reduce((a, r) => a.plus(r.debit), D(0))),
    byReason: ign.map((r) => ({ reason: r.reason ?? 'OTHER', count: r.n, in: money2(D(r.credit)), out: money2(D(r.debit)) })),
  };
  return {
    asAt, summary, ignored: ignoredSummary,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>,
    outstandingEntries: outstanding.slice(-25).map((e) => ({ id: e.id, date: e.date, debit: e.debit, credit: e.credit, narration: e.narration })),
    note: account.scope === 'BRANCH'
      ? 'Book balance is the whole BANK ledger of this branch. If the branch uses several bank accounts, they share one ledger.'
      : 'Book balance is the sum of the BANK ledgers of every outlet in the business.',
  };
}
