import { Decimal } from 'decimal.js';

/**
 * PURE: what an outlet owes each supplier, and how old it is.
 *
 * The books keep one SUNDRY_CREDITORS control ledger, so the per-supplier picture is derived: every APPROVED invoice adds its
 * payable total; the e-challan paid with the invoice and every recorded payment reduce it. Money paid goes against the OLDEST
 * invoice first (FIFO), which is how a supplier statement is normally read. Money paid beyond what is owed is an advance.
 */
export interface PayableInvoice {
  id: string;
  supplier: string;
  number: string;
  date: string;              // YYYY-MM-DD (invoice date, else approval date)
  payable: string;           // what the invoice added to the creditors ledger
  settledByChallan: string;  // paid with the invoice itself (e-challan / DD)
}
export interface SupplierPaymentIn { supplier: string; amount: string; date: string }

export type AgeBucket = 'current' | 'd31_60' | 'd61_90' | 'd90plus';

export interface OpenInvoice { id: string; number: string; date: string; payable: string; outstanding: string; ageDays: number; bucket: AgeBucket }
export interface SupplierBalance {
  supplier: string;
  invoiced: string;
  paid: string;
  outstanding: string;
  advance: string;           // paid beyond what was invoiced
  buckets: Record<AgeBucket, string>;
  openInvoices: OpenInvoice[];
}
export interface Creditors {
  asOf: string;
  suppliers: SupplierBalance[];
  totals: { outstanding: string; advance: string; buckets: Record<AgeBucket, string> };
}

export const supplierKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export function ageBucket(ageDays: number): AgeBucket {
  if (ageDays <= 30) return 'current';
  if (ageDays <= 60) return 'd31_60';
  if (ageDays <= 90) return 'd61_90';
  return 'd90plus';
}

const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000));
const zeroBuckets = (): Record<AgeBucket, Decimal> => ({ current: new Decimal(0), d31_60: new Decimal(0), d61_90: new Decimal(0), d90plus: new Decimal(0) });
const fmtBuckets = (b: Record<AgeBucket, Decimal>): Record<AgeBucket, string> => ({ current: b.current.toFixed(2), d31_60: b.d31_60.toFixed(2), d61_90: b.d61_90.toFixed(2), d90plus: b.d90plus.toFixed(2) });

export function buildCreditors(invoices: PayableInvoice[], payments: SupplierPaymentIn[], asOf: string): Creditors {
  const names = new Map<string, string>();   // key -> first spelling seen
  for (const i of invoices) if (!names.has(supplierKey(i.supplier))) names.set(supplierKey(i.supplier), i.supplier.trim());
  for (const p of payments) if (!names.has(supplierKey(p.supplier))) names.set(supplierKey(p.supplier), p.supplier.trim());

  const totalBuckets = zeroBuckets();
  let totalOutstanding = new Decimal(0);
  let totalAdvance = new Decimal(0);

  const suppliers: SupplierBalance[] = [...names.entries()].map(([key, display]) => {
    const inv = invoices.filter((i) => supplierKey(i.supplier) === key && i.date <= asOf).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
    const paidIn = payments.filter((p) => supplierKey(p.supplier) === key && p.date <= asOf);
    let pool = paidIn.reduce((n, p) => n.plus(p.amount), new Decimal(0));
    const paidTotal = pool.plus(inv.reduce((n, i) => n.plus(i.settledByChallan), new Decimal(0)));
    const invoiced = inv.reduce((n, i) => n.plus(i.payable), new Decimal(0));

    const buckets = zeroBuckets();
    const open: OpenInvoice[] = [];
    for (const i of inv) {
      let owed = new Decimal(i.payable).minus(i.settledByChallan);
      if (owed.isNegative()) { pool = pool.plus(owed.negated()); owed = new Decimal(0); }   // challan above the invoice: the excess is an advance
      const applied = Decimal.min(pool, owed);
      pool = pool.minus(applied);
      owed = owed.minus(applied);
      if (owed.gt(0)) {
        const age = daysBetween(i.date, asOf);
        const bucket = ageBucket(age);
        buckets[bucket] = buckets[bucket].plus(owed);
        open.push({ id: i.id, number: i.number, date: i.date, payable: new Decimal(i.payable).toFixed(2), outstanding: owed.toFixed(2), ageDays: age, bucket });
      }
    }
    const outstanding = open.reduce((n, o) => n.plus(o.outstanding), new Decimal(0));
    totalOutstanding = totalOutstanding.plus(outstanding);
    totalAdvance = totalAdvance.plus(pool);
    (Object.keys(buckets) as AgeBucket[]).forEach((k) => { totalBuckets[k] = totalBuckets[k].plus(buckets[k]); });
    return {
      supplier: display, invoiced: invoiced.toFixed(2), paid: paidTotal.toFixed(2), outstanding: outstanding.toFixed(2), advance: pool.toFixed(2),
      buckets: fmtBuckets(buckets), openInvoices: open,
    };
  });

  // who is owed most first; suppliers that are fully settled sink to the bottom
  suppliers.sort((a, b) => new Decimal(b.outstanding).comparedTo(a.outstanding) || a.supplier.localeCompare(b.supplier));
  return { asOf, suppliers, totals: { outstanding: totalOutstanding.toFixed(2), advance: totalAdvance.toFixed(2), buckets: fmtBuckets(totalBuckets) } };
}
