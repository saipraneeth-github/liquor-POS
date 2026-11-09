/**
 * ChallanTotals — the totals block of a depot challan (ICDC): every printed figure is stored and editable, and the
 * four arithmetic links between them are re-checked live. Mirrors src/modules/invoices/totals.engine.ts; the server
 * re-runs the same checks on save and refuses to review/approve while any link is broken.
 */

export interface ChallanFigures {
  linesBasicTotal?: string | null;
  mrpRoundingOff?: string | null;
  netInvoiceValue?: string | null;
  turnoverTax?: string | null;
  specialExciseCess?: string | null;
  tcsAmount?: string | null;
  challanAmount?: string | null;
  previousCredit?: string | null;
  subTotal?: string | null;
  retailerCreditBalance?: string | null;
  totalInvoiceAmount?: string | null;
}

export type ChallanField = keyof ChallanFigures;

interface Check { label: string; expected: number | null; actual: number | null; ok: boolean | null }

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const inr = (n: number | null) => (n === null ? '—' : '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function reconcileChallan(f: ChallanFigures, linesSum: number): Check[] {
  const iv = num(f.linesBasicTotal), rnd = num(f.mrpRoundingOff), net = num(f.netInvoiceValue);
  const prev = num(f.previousCredit), sub = num(f.subTotal), bal = num(f.retailerCreditBalance);
  const ch = num(f.challanAmount) ?? (prev !== null ? 0 : null);
  const tot = num(f.turnoverTax) ?? 0, cess = num(f.specialExciseCess) ?? 0, tcs = num(f.tcsAmount) ?? 0;
  const mk = (label: string, expected: number | null, actual: number | null, tol: number): Check => ({
    label, expected, actual, ok: expected === null || actual === null ? null : Math.abs(actual - expected) <= tol + 1e-9,
  });
  return [
    mk('Sum of lines = Invoice Value', iv, linesSum, 1),
    mk('Invoice Value + MRP Rounding Off = Net Invoice Value', iv !== null && rnd !== null ? iv + rnd : null, net, 0.05),
    mk('Previous Credit + e-challan/DD = Sub Total', prev !== null && ch !== null ? prev + ch : null, sub, 0.05),
    mk('Sub Total − Net − Turnover Tax − Cess − TCS = Retailer Balance', sub !== null && net !== null ? sub - net - tot - cess - tcs : null, bal, 0.05),
  ];
}

const FIELDS: Array<{ key: ChallanField; label: string; hint?: string }> = [
  { key: 'linesBasicTotal', label: 'Invoice Value', hint: 'wholesale total of the lines' },
  { key: 'mrpRoundingOff', label: 'MRP Rounding Off' },
  { key: 'netInvoiceValue', label: 'Net Invoice Value', hint: '(-) Less this Invoice Value' },
  { key: 'turnoverTax', label: 'Turnover Tax' },
  { key: 'specialExciseCess', label: 'Special Excise Cess' },
  { key: 'tcsAmount', label: 'TCS' },
  { key: 'previousCredit', label: 'Previous Credit' },
  { key: 'challanAmount', label: 'e-challan / DD Amount' },
  { key: 'subTotal', label: 'Sub Total' },
  { key: 'retailerCreditBalance', label: 'Retailer Credit Balance' },
];

export default function ChallanTotals({
  figures, linesSum, editable, onChange,
}: {
  figures: ChallanFigures;
  linesSum: number;
  editable: boolean;
  onChange: (field: ChallanField, value: string) => void;
}) {
  const checks = reconcileChallan(figures, linesSum);
  const failed = checks.filter((c) => c.ok === false).length;
  const unverified = checks.filter((c) => c.ok === null).length;
  const payable = (num(figures.netInvoiceValue) ?? 0) + (num(figures.turnoverTax) ?? 0) + (num(figures.specialExciseCess) ?? 0) + (num(figures.tcsAmount) ?? 0);

  return (
    <div className="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-800" id="challanTotals">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Challan totals</h3>
        {failed > 0 ? (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-300">
            {failed} check{failed > 1 ? 's' : ''} failed — approval is blocked until fixed
          </span>
        ) : unverified > 0 ? (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">
            {unverified} check{unverified > 1 ? 's' : ''} could not be verified
          </span>
        ) : (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
            ✓ All totals reconcile
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1.5 text-xs">
        {checks.map((c) => (
          <li key={c.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5">
            <span className="flex items-center gap-2">
              <span aria-hidden className={c.ok === false ? 'text-rose-600' : c.ok === null ? 'text-amber-600' : 'text-emerald-600'}>
                {c.ok === false ? '✗' : c.ok === null ? '?' : '✓'}
              </span>
              <span className="text-gray-700 dark:text-slate-300">{c.label}</span>
            </span>
            <span className="font-mono text-gray-600 dark:text-slate-400">
              {c.ok === null ? 'needs the missing figure' : c.ok ? inr(c.actual) : `should be ${inr(c.expected)}, is ${inr(c.actual)}`}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 pt-3 border-t dark:border-slate-800 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-xs">
        {FIELDS.map((f) => (
          <label key={f.key} className="block p-2 bg-white dark:bg-slate-950/40 rounded border border-slate-200 dark:border-slate-800">
            <span className="text-gray-500 dark:text-slate-400 text-[10px] block leading-tight">{f.label}</span>
            {editable ? (
              <input
                inputMode="decimal"
                aria-label={f.label}
                className="w-full mt-0.5 bg-transparent font-mono font-bold text-gray-900 dark:text-gray-100 outline-none"
                value={figures[f.key] ?? ''}
                placeholder="—"
                onChange={(e) => onChange(f.key, e.target.value.replace(/[^\d.]/g, ''))}
              />
            ) : (
              <span className="font-mono font-bold text-gray-900 dark:text-gray-100">{inr(num(figures[f.key]))}</span>
            )}
          </label>
        ))}
        <div className="block p-2 rounded border border-indigo-200 bg-indigo-50/60 dark:bg-indigo-950/30 dark:border-indigo-900/50">
          <span className="text-gray-500 dark:text-slate-400 text-[10px] block leading-tight">Total payable to depot</span>
          <span className="font-mono font-bold text-indigo-900 dark:text-indigo-200">{inr(payable)}</span>
        </div>
      </div>
    </div>
  );
}
