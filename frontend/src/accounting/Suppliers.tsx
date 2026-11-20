import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth, userCan } from '../auth/AuthProvider';
import { businessDate } from '../lib/business-day';
import { errorMessage, showToast } from '../lib/print';

type Buckets = { current: string; d31_60: string; d61_90: string; d90plus: string };
type OpenInvoice = { id: string; number: string; date: string; outstanding: string; ageDays: number };
type SupplierBalance = { supplier: string; invoiced: string; paid: string; outstanding: string; advance: string; buckets: Buckets; openInvoices: OpenInvoice[] };
type Ageing = { asOf: string; suppliers: SupplierBalance[]; totals: { outstanding: string; advance: string; buckets: Buckets } };
type Payment = { id: string; supplierName: string; amount: string; paymentMode: string; paymentDate: string; reference: string | null; voidedAt: string | null; voidReason: string | null };

const money = (v: string) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MODES = ['BANK', 'UPI', 'CARD', 'CASH'] as const;
const BUCKETS: [keyof Buckets, string][] = [['current', '0-30 days'], ['d31_60', '31-60'], ['d61_90', '61-90'], ['d90plus', '90+ days']];

/** What the outlet owes each supplier (aged), and the payments made to them. */
type StockProduct = { productId: string; name: string; quantity: number };
type PurchaseReturn = { id: string; returnNumber: string; supplierName: string; amount: string; reason: string; createdAt: string; items: { name: string; quantity: number }[] };

/** Bottles going back to a supplier (a debit note): they leave stock and reduce what is owed. Needs "approve supplier invoices". */
function SupplierReturn({ branchId, suppliers, onDone }: { branchId: string; suppliers: string[]; onDone: () => void }) {
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [past, setPast] = useState<PurchaseReturn[]>([]);
  const [form, setForm] = useState({ supplierName: '', productId: '', quantity: '', unitCost: '', reason: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.get<StockProduct[]>(`/inventory/stock/${branchId}`), api.get<{ returns: PurchaseReturn[] }>(`/purchase-returns?branchId=${branchId}`)]);
      setProducts(p.filter((x) => x.quantity > 0));
      setPast(r.returns.slice(0, 10));
    } catch { /* a user without the permission simply does not see the panel's data */ }
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post<{ returnNumber: string; amount: string }>('/purchase-returns', {
        branchId, supplierName: form.supplierName.trim(), reason: form.reason.trim(),
        items: [{ productId: form.productId, quantity: Number(form.quantity), ...(form.unitCost.trim() ? { unitCost: form.unitCost.trim() } : {}) }],
      });
      showToast(`Return ${res.returnNumber}: ${money(res.amount)} off what you owe`, 'success');
      setForm({ ...form, productId: '', quantity: '', unitCost: '', reason: '' });
      await load(); onDone();
    } catch (err) { showToast(errorMessage(err), 'error'); } finally { setSaving(false); }
  };

  return (
    <div id="supplierReturn" className="border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800 p-3 space-y-3">
      <div className="text-xs font-semibold text-gray-500">Return goods to a supplier</div>
      <form onSubmit={submit} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
        <label className="text-xs font-semibold md:col-span-2">Supplier
          <input id="prSupplier" list="spNames" className="input-base mt-1 w-full" required minLength={2} value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} />
          <datalist id="spNames">{suppliers.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <label className="text-xs font-semibold md:col-span-2">Product
          <select id="prProduct" className="input-base mt-1 w-full" required value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
            <option value="">Choose…</option>
            {products.map((p) => <option key={p.productId} value={p.productId}>{p.name} ({p.quantity} in stock)</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold">Bottles
          <input id="prQty" className="input-base mt-1 w-full" required inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value.replace(/\D/g, '') })} />
        </label>
        <label className="text-xs font-semibold">Cost each (₹)
          <input className="input-base mt-1 w-full" inputMode="decimal" placeholder="last cost" value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} />
        </label>
        <label className="text-xs font-semibold md:col-span-5">Reason
          <input id="prReason" className="input-base mt-1 w-full" required minLength={5} maxLength={300} placeholder="e.g. leaking bottles, wrong brand delivered" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </label>
        <button id="prSave" type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-60">Record return</button>
      </form>
      {past.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {past.map((r) => (
              <tr key={r.id} className="border-t dark:border-gray-700">
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{r.returnNumber}</td><td className="pr-3">{r.supplierName}</td>
                <td className="pr-3">{r.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')}</td><td className="text-right font-mono">{money(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Suppliers({ branchId }: { branchId: string }) {
  const { user } = useAuth();
  const canPost = userCan(user, 'accounting.post');
  const canReturn = userCan(user, 'invoices.approve') && userCan(user, 'cost.view');
  const [ageing, setAgeing] = useState<Ageing | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ supplierName: '', amount: '', paymentMode: 'BANK' as (typeof MODES)[number], paymentDate: businessDate(), reference: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const [a, p] = await Promise.all([
        api.get<Ageing>(`/accounting/suppliers/${branchId}/ageing`),
        api.get<{ payments: Payment[] }>(`/accounting/suppliers/${branchId}/payments?from=${businessDate(-90)}`),
      ]);
      setAgeing(a);
      setPayments(p.payments);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/accounting/suppliers/${branchId}/payments`, {
        supplierName: form.supplierName.trim(), amount: form.amount.trim(), paymentMode: form.paymentMode, paymentDate: form.paymentDate,
        ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
      });
      showToast('Payment recorded', 'success');
      setForm({ ...form, amount: '', reference: '' });
      await load();
    } catch (err) { showToast(errorMessage(err), 'error'); } finally { setSaving(false); }
  };

  const voidIt = async (p: Payment) => {
    const reason = window.prompt(`Void the ${money(p.amount)} payment to ${p.supplierName}? Why? (at least 10 characters)`);
    if (!reason) return;
    try {
      await api.post(`/accounting/suppliers/${branchId}/payments/${p.id}/void`, { reason });
      showToast('Payment voided and reversed in the books', 'success');
      await load();
    } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  return (
    <div id="suppliersTab" className="space-y-4">
      {ageing && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <div className="p-3 rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800"><div className="text-xs text-gray-500">Total owed</div><div className="font-mono font-bold text-lg">{money(ageing.totals.outstanding)}</div></div>
          {BUCKETS.map(([k, label]) => (
            <div key={k} className="p-3 rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800"><div className="text-xs text-gray-500">{label}</div><div className="font-mono font-semibold">{money(ageing.totals.buckets[k])}</div></div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="px-3 py-2">Supplier</th><th className="px-3 py-2 text-right">Invoiced</th><th className="px-3 py-2 text-right">Paid</th><th className="px-3 py-2 text-right">Owed</th>{BUCKETS.map(([, l]) => <th key={l} className="px-3 py-2 text-right">{l}</th>)}</tr></thead>
          <tbody>
            {(ageing?.suppliers ?? []).length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">No approved supplier invoices yet.</td></tr>}
            {(ageing?.suppliers ?? []).map((s) => (
              <Fragment key={s.supplier}>
                <tr className="border-t dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750" onClick={() => setOpen(open === s.supplier ? null : s.supplier)}>
                  <td className="px-3 py-2 font-medium">{s.supplier}{Number(s.advance) > 0 && <span className="ml-2 text-emerald-700">advance {money(s.advance)}</span>}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(s.invoiced)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(s.paid)}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold">{money(s.outstanding)}</td>
                  {BUCKETS.map(([k]) => <td key={k} className="px-3 py-2 text-right font-mono">{Number(s.buckets[k]) ? money(s.buckets[k]) : ''}</td>)}
                </tr>
                {open === s.supplier && s.openInvoices.map((o) => (
                  <tr key={o.id} className="bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300">
                    <td className="px-3 py-1.5 pl-8" colSpan={3}>Invoice {o.number} · {o.date} · {o.ageDays} days old</td>
                    <td className="px-3 py-1.5 text-right font-mono">{money(o.outstanding)}</td><td colSpan={4} />
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {canPost && (
        <form onSubmit={pay} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end p-3 border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
          <label className="text-xs font-semibold md:col-span-2">Supplier
            <input id="spName" list="spNames" className="input-base mt-1 w-full" required minLength={2} value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} />
            <datalist id="spNames">{(ageing?.suppliers ?? []).map((s) => <option key={s.supplier} value={s.supplier} />)}</datalist>
          </label>
          <label className="text-xs font-semibold">Amount (₹)
            <input id="spAmount" className="input-base mt-1 w-full" required inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </label>
          <label className="text-xs font-semibold">Paid by
            <select id="spMode" className="input-base mt-1 w-full" value={form.paymentMode} onChange={(e) => setForm({ ...form, paymentMode: e.target.value as (typeof MODES)[number] })}>
              {MODES.map((m) => <option key={m} value={m}>{m === 'CASH' ? 'Cash (from drawer)' : m}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">Date
            <input type="date" className="input-base mt-1 w-full" max={businessDate()} value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} />
          </label>
          <label className="text-xs font-semibold">UTR / cheque no.
            <input className="input-base mt-1 w-full" maxLength={80} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </label>
          <button id="spSave" type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-60 md:col-span-6 md:w-fit">Record payment</button>
        </form>
      )}

      {canReturn && <SupplierReturn branchId={branchId} suppliers={(ageing?.suppliers ?? []).map((s) => s.supplier)} onDone={() => { void load(); }} />}

      <div className="overflow-x-auto border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-3 py-2 text-xs font-semibold text-gray-500">Payments in the last 90 days</div>
        <table className="w-full text-xs">
          <tbody>
            {payments.length === 0 && <tr><td className="px-3 py-4 text-center text-gray-500">No payments recorded.</td></tr>}
            {payments.map((p) => (
              <tr key={p.id} className={`border-t dark:border-gray-700 ${p.voidedAt ? 'text-gray-400 line-through' : ''}`}>
                <td className="px-3 py-2 whitespace-nowrap">{p.paymentDate}</td><td className="px-3 py-2">{p.supplierName}</td><td className="px-3 py-2">{p.paymentMode}</td>
                <td className="px-3 py-2 text-right font-mono">{money(p.amount)}</td><td className="px-3 py-2">{p.voidedAt ? `VOID - ${p.voidReason}` : p.reference}</td>
                <td className="px-3 py-2 text-right">{canPost && !p.voidedAt && <button type="button" className="underline text-red-600" onClick={() => voidIt(p)}>Void</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
