/** What the Super Admin screens know about a plan (GET /platform/plans). */
export interface PlanInfo {
  code: string;
  name: string;
  price: string;
  cycleDays: number;
  maxBranches: number;
  features: string[];
  isActive: boolean;
  tenantCount: number;
}

export const CYCLE_OPTIONS = [
  { days: 30, label: 'Monthly', word: 'month' },
  { days: 90, label: 'Quarterly', word: 'quarter' },
  { days: 365, label: 'Yearly', word: 'year' },
] as const;

export const cycleWord = (days: number) => CYCLE_OPTIONS.find((c) => c.days === days)?.word ?? `${days} days`;

export const planTone = (code: string): 'warn' | 'info' | 'good' => (code === 'TRIAL' ? 'warn' : code === 'PRO' ? 'good' : 'info');

/** The business date (IST) as yyyy-mm-dd, `plus` days from today. */
export const businessDay = (plus = 0) => new Date(Date.now() + 330 * 60_000 + plus * 86_400_000).toISOString().slice(0, 10);

export const fmtDay = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** The answer of GET /platform/tenants/:id/plan-preview. */
export interface PlanPreview {
  current: { code: string; name: string; price: string; cycleDays: number };
  target: { code: string; name: string; price: string; cycleDays: number; maxBranches: number };
  effectiveDate: string;
  paidUntil: string | null;
  currentPaid: boolean;
  unusedDays: number;
  credit: string;
  newPrice: string;
  amountDue: string;
  periodStart: string;
  periodEnd: string;
  branchesInUse: number;
  fitsBranches: boolean;
  sameAsCurrent: boolean;
  warnings: string[];
}
