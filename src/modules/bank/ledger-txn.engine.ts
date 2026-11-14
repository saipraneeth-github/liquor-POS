/**
 * ledger-txn.engine.ts — pure rules for the transactions table: what a recorded line is called, and how a search is read.
 */

/** What the user sees for a built-in bank category (Rent / Wages / ... are the words the books use for them). */
const BUILT_IN_LABEL: Record<string, string> = {
  SETTLEMENT: 'Card / UPI settlement',
  CASH_DEPOSIT: 'Cash deposit',
  CASH_WITHDRAWAL: 'Cash withdrawal',
  BANK_CHARGE: 'Bank charges',
  INTEREST: 'Interest',
  SUPPLIER_PAYMENT: 'Supplier payment',
  SUPPLIER_REFUND: 'Supplier refund',
  OWNER_CAPITAL: 'Owner capital',
  OWNER_DRAWINGS: 'Owner drawings',
  EXCISE_GOVT: 'Excise / government',
  SALARY_WAGES: 'Salaries & Wages',
  RENT: 'Rent',
  MISC_EXPENSES: 'Miscellaneous',
  UTILITIES: 'Utilities',
  INTER_ACCOUNT_IN: 'Transfer in',
  INTER_ACCOUNT_OUT: 'Transfer out',
  OTHER_RECEIPT: 'Other receipt',
  OTHER_PAYMENT: 'Other payment',
};

export const categoryLabel = (category: string): string => BUILT_IN_LABEL[category] ?? category;
export const categoryKey = (label: string): string => label.trim().toLowerCase();

/** The categories every account can start with. Their books ledgers are created on demand (expense accounts). */
export const DEFAULT_CATEGORIES = ['Rent', 'Wages', 'Utilities', 'Supplies'] as const;

/** A search box: every word must appear in the description, category or reference. */
export function searchWords(q: string | undefined): string[] {
  return (q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}
