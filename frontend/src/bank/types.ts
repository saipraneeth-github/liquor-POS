export type Scope = 'BRANCH' | 'SYNDICATE';

export type Account = {
  id: string;
  branchId: string;
  syndicateId: string | null;
  scope: Scope;
  name: string;
  bankName: string | null;
  accountLast4: string | null;
  isActive: boolean;
};

export type BalanceCheck = {
  status: 'PASS' | 'FAIL' | 'UNVERIFIABLE';
  message: string;
  checked: number;
  breaks: { lineNo: number; expected: string; actual: string }[];
  opening: string | null;
  closing: string | null;
  computedClosing: string | null;
  totalDebit: string;
  totalCredit: string;
};

export type ColumnKey = 'date' | 'valueDate' | 'narration' | 'reference' | 'debit' | 'credit' | 'amount' | 'drCr' | 'balance';
export type ColumnMapping = Partial<Record<ColumnKey, number>>;

export type PreviewLine = {
  lineNo: number;
  txnDate: string;
  valueDate: string | null;
  narration: string;
  reference: string | null;
  debit: string;
  credit: string;
  balance: string | null;
  confidence: number;
  flags: string[];
};

export type Preview = {
  source: 'CSV' | 'EXCEL' | 'PDF';
  headers: string[];
  headerRow: number;
  mapping: ColumnMapping;
  method: 'HEADER' | 'CONTENT' | 'MANUAL';
  mappingConfidence: number;
  dayFirst: boolean;
  lines: PreviewLine[];
  lineCount: number;
  duplicateLines: number;
  newLines: number;
  alreadyImported: boolean;
  existingStatementId: string | null;
  skippedRows: number;
  balanceCheck: BalanceCheck;
  periodStart: string | null;
  periodEnd: string | null;
  warnings: string[];
  sampleRows: string[][];
  totalRows: number;
};

export type StatementRow = {
  id: string;
  accountId: string;
  originalFilename: string | null;
  source: string;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  lineCount: number;
  duplicateCount: number;
  status: 'IMPORTED' | 'RECONCILED';
  balanceCheck: BalanceCheck | null;
  warnings: string[] | null;
  createdAt: string;
  counts: Record<string, number>;
};

export type IgnoreReason = 'PERSONAL' | 'OTHER_BUSINESS' | 'NOT_OURS' | 'OTHER';

export const IGNORE_REASON_LABEL: Record<IgnoreReason, string> = {
  PERSONAL: 'Personal (owner / family)',
  OTHER_BUSINESS: 'Another business',
  NOT_OURS: 'Not ours / not the store',
  OTHER: 'Other',
};
export const IGNORE_REASONS = Object.keys(IGNORE_REASON_LABEL) as IgnoreReason[];

export type IgnoreRule = {
  id: string;
  accountId: string;
  pattern: string;
  side: 'ANY' | 'IN' | 'OUT';
  minAmount: string | null;
  maxAmount: string | null;
  reason: IgnoreReason;
  action: 'SUGGEST' | 'AUTO';
  isActive: boolean;
  createdAt: string;
  ignoredLines: number;
};

export type RuleDraft = {
  pattern: string;
  side: 'ANY' | 'IN' | 'OUT';
  minAmount?: string;
  maxAmount?: string;
  action: 'SUGGEST' | 'AUTO';
};

export type Suggestion =
  | { kind: 'IGNORE'; ruleId: string; pattern: string; ignoreReason: IgnoreReason; confidence: number; reason: string }
  | { kind: 'ONE_TO_ONE'; entryIds: string[]; confidence: number; reason: string }
  | { kind: 'SETTLEMENT'; entryIds: string[]; expected: string; fee: string; feePct: number; days: string[]; mode: string; confidence: number; reason: string }
  | { kind: 'POST'; category: Category; confidence: number; reason: string };

export type Category =
  | 'SETTLEMENT' | 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL' | 'BANK_CHARGE' | 'INTEREST'
  | 'SUPPLIER_PAYMENT' | 'OTHER_RECEIPT' | 'OTHER_PAYMENT';

export type LineStatus = 'UNMATCHED' | 'SUGGESTED' | 'MATCHED' | 'IGNORED';

export type Line = {
  id: string;
  lineNo: number;
  txnDate: string;
  narration: string;
  reference: string | null;
  debit: string;
  credit: string;
  balance: string | null;
  status: LineStatus;
  category: string | null;
  suggestion: Suggestion | null;
  confidence: string | null;
  feeAmount: string;
  note: string | null;
  voucherId: string | null;
  ignoreReason: IgnoreReason | null;
  ignoredByRuleId: string | null;
  suggestedPattern: string;
};

export type Candidate = { id: string; date: string; debit: string; credit: string; narration: string; sourceType: string | null };

export type Summary = {
  asAt: string;
  summary: {
    bankClosing: string | null;
    bookBalance: string;
    outstandingReceipts: string;
    outstandingPayments: string;
    unpostedReceipts: string;
    unpostedPayments: string;
    ignoredNet: string;
    adjustedBank: string | null;
    difference: string | null;
    booksComplete: boolean;
    reconciled: boolean;
  };
  counts: Record<string, number>;
  ignored: { count: number; totalIn: string; totalOut: string; byReason: { reason: IgnoreReason; count: number; in: string; out: string }[] };
  outstandingEntries: { id: string; date: string; debit: string; credit: string; narration: string }[];
  note: string;
};

export const CATEGORY_LABEL: Record<string, string> = {
  SETTLEMENT: 'Card / UPI settlement',
  BOOK_MATCH: 'Matched to a book entry',
  CASH_DEPOSIT: 'Cash deposit',
  CASH_WITHDRAWAL: 'Cash withdrawal',
  BANK_CHARGE: 'Bank charge / fee',
  INTEREST: 'Interest received',
  SUPPLIER_PAYMENT: 'Supplier payment',
  OTHER_RECEIPT: 'Other receipt',
  OTHER_PAYMENT: 'Other payment',
};

export const isZero = (v: string | null | undefined) => !v || Number(v) === 0;
