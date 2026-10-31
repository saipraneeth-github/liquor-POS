import { and, eq } from 'drizzle-orm';
import { accountLedgers } from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';

// ─── CHART OF ACCOUNTS ───────────────────────────────────────────────────────
//
// Every branch keeps its own books. SYSTEM ledgers are created idempotently the first
// time anything is posted for a branch (or a report is opened). Expense ledgers are
// created on demand, one per expense category: EXPENSE_<CATEGORY>.

export type LedgerGroup = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export interface LedgerDefinition {
  code: string;
  name: string;
  group: LedgerGroup;
}

export const SYSTEM_LEDGERS = [
  { code: 'CASH',             name: 'Cash in Hand',        group: 'ASSET' },
  { code: 'BANK',             name: 'Bank Account',        group: 'ASSET' },      // card + UPI + bank transfers
  { code: 'SUNDRY_DEBTORS',   name: 'Sundry Debtors',      group: 'ASSET' },      // khata (credit) customers
  { code: 'INVENTORY',        name: 'Stock in Hand',       group: 'ASSET' },
  { code: 'INPUT_GST',        name: 'Input GST',           group: 'ASSET' },
  { code: 'SUNDRY_CREDITORS', name: 'Sundry Creditors',    group: 'LIABILITY' },  // suppliers
  { code: 'OUTPUT_GST',       name: 'Output GST',          group: 'LIABILITY' },
  { code: 'CAPITAL',          name: 'Capital Account',     group: 'EQUITY' },
  { code: 'SALES',            name: 'Sales Account',       group: 'INCOME' },
  { code: 'PURCHASES',        name: 'Purchase Account',    group: 'EXPENSE' },
  { code: 'DISCOUNT_ALLOWED', name: 'Discount Allowed',    group: 'EXPENSE' },
  { code: 'ROUND_OFF',        name: 'Round Off',           group: 'EXPENSE' },
] as const satisfies readonly LedgerDefinition[];

export type SystemLedgerCode = (typeof SYSTEM_LEDGERS)[number]['code'];

export const SYSTEM_LEDGER_CODES: ReadonlySet<string> = new Set(SYSTEM_LEDGERS.map((l) => l.code));

export const EXPENSE_LEDGER_PREFIX = 'EXPENSE_';

/** True for codes reserved for system ledgers (fixed set + EXPENSE_*). */
export function isReservedLedgerCode(code: string): boolean {
  return SYSTEM_LEDGER_CODES.has(code) || code.startsWith(EXPENSE_LEDGER_PREFIX);
}

/** 'Staff Salaries' → 'STAFF_SALARIES'. */
export function normalizeLedgerCode(raw: string): string {
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!code) throw new Error(`Cannot derive a ledger code from "${raw}"`);
  return code;
}

export function expenseLedgerCode(category: string): string {
  return `${EXPENSE_LEDGER_PREFIX}${normalizeLedgerCode(category)}`;
}

export function expenseLedgerDefinition(category: string): LedgerDefinition {
  return { code: expenseLedgerCode(category), name: `${category.trim()} Expense`, group: 'EXPENSE' };
}

// ─── DB HELPERS ──────────────────────────────────────────────────────────────

/** Idempotently creates the system ledgers for a branch. Returns ledger id by code (all branch ledgers). */
export async function ensureSystemLedgers(tx: Tx, branchId: string): Promise<Map<string, string>> {
  await tx
    .insert(accountLedgers)
    .values(SYSTEM_LEDGERS.map((l) => ({ branchId, code: l.code, name: l.name, group: l.group, isSystem: true })))
    .onConflictDoNothing({ target: [accountLedgers.branchId, accountLedgers.code] });

  const rows = await tx
    .select({ id: accountLedgers.id, code: accountLedgers.code })
    .from(accountLedgers)
    .where(eq(accountLedgers.branchId, branchId));
  return new Map(rows.map((r) => [r.code, r.id]));
}

/** Idempotently creates one (system) ledger and returns its id. */
export async function ensureLedger(tx: Tx, branchId: string, def: LedgerDefinition): Promise<string> {
  await tx
    .insert(accountLedgers)
    .values({ branchId, code: def.code, name: def.name, group: def.group, isSystem: true })
    .onConflictDoNothing({ target: [accountLedgers.branchId, accountLedgers.code] });
  const [row] = await tx
    .select({ id: accountLedgers.id })
    .from(accountLedgers)
    .where(and(eq(accountLedgers.branchId, branchId), eq(accountLedgers.code, def.code)))
    .limit(1);
  return row.id;
}
