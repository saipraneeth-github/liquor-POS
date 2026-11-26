import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth, userCan } from '../auth/AuthProvider';
import { businessDate } from '../lib/business-day';
import { errorMessage, showToast } from '../lib/print';

type Expense = {
  id: string; category: string; amount: string; paymentMode: string; expenseDate: string; notes: string | null;
  voidedAt: string | null; voidReason: string | null;
};
type ExpenseList = { expenses: Expense[]; total: string; count: number; voidedCount: number; totalsByCategory: { category: string; total: string; count: number }[] };
type YearSummary = { year: number; total: string; months: { month: number; total: string; count: number }[] };

const money = (v: string) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MODES = ['CASH', 'UPI', 'CARD', 'BANK'] as const;

/** Expenses of the outlet: record one, see the totals by category, void one that was entered by mistake (never deleted). */
export function Expenses({ branchId }: { branchId: string }) {
  const { user } = useAuth();
  const canPost = userCan(user, 'accounting.post');
  const [from, setFrom] = useState(businessDate(-30));
  const [to, setTo] = useState(businessDate());
  const [data, setData] = useState<ExpenseList | null>(null);
  const [year, setYear] = useState(Number(businessDate().slice(0, 4)));
  const [summary, setSummary] = useState<YearSummary | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [form, setForm] = useState({ category: '', amount: '', paymentMode: 'CASH' as (typeof MODES)[number], expenseDate: businessDate(), notes: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const [ledger, totals] = await Promise.all([
        api.get<ExpenseList>(`/expenses/${branchId}?from=${from}&to=${to}`),
        api.get<YearSummary>(`/expenses/${branchId}/summary?year=${year}`),
      ]);
      setData(ledger);
      setSummary(totals);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  }, [branchId, from, to, year]);

  useEffect(() => { void load(); }, [load]);
  const visible = (data?.expenses ?? []).filter((expense) =>
    (!categoryFilter || expense.category === categoryFilter) &&
    (!paymentFilter || expense.paymentMode === paymentFilter));
  const categories = [...new Set((data?.expenses ?? []).map((expense) => expense.category))].sort();

  const record = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/expenses/${branchId}`, {
        category: form.category.trim(), amount: form.amount.trim(), paymentMode: form.paymentMode,
        expenseDate: form.expenseDate, ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      });
      showToast('Expense recorded', 'success');
      setForm({ ...form, category: '', amount: '', notes: '' });
      await load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const voidIt = async (x: Expense) => {
    const reason = window.prompt(`Void ${x.category} ${money(x.amount)}? Why? (at least 10 characters)`);
    if (!reason) return;
    try {
      await api.post(`/expenses/${branchId}/${x.id}/void`, { reason });
      showToast('Expense voided and reversed in the books', 'success');
      await load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  return (
    <div id="expensesTab" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <label className="text-sm font-semibold">Year <input type="number" min="2000" max="2100" className="input-base mt-1 w-28" value={year} onChange={(event) => setYear(Number(event.target.value))} /></label>
        <div className="text-sm">Year total <strong className="block text-xl">{money(summary?.total ?? '0')}</strong></div>
        <div className="flex flex-wrap gap-2">{summary?.months.map((month) => <div key={month.month} className="min-w-20 rounded-lg border px-2 py-1 text-xs dark:border-gray-600"><span className="block">{new Date(year, month.month - 1).toLocaleString('en-IN', { month: 'short' })}</span><strong>{money(month.total)}</strong></div>)}</div>
      </div>
      {canPost && (
        <form onSubmit={record} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end p-3 border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
          <label className="text-xs font-semibold md:col-span-1">Category
            <input id="expCategory" className="input-base mt-1" required minLength={2} maxLength={60} placeholder="Rent, Tea, Salaries" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </label>
          <label className="text-xs font-semibold">Amount (₹)
            <input id="expAmount" className="input-base mt-1" required inputMode="decimal" pattern="\d{1,10}(\.\d{1,2})?" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </label>
          <label className="text-xs font-semibold">Paid by
            <select id="expMode" className="input-base mt-1" value={form.paymentMode} onChange={(e) => setForm({ ...form, paymentMode: e.target.value as (typeof MODES)[number] })}>
              {MODES.map((m) => <option key={m} value={m}>{m === 'CASH' ? 'Cash (from drawer)' : m}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">Date
            <input id="expDate" type="date" className="input-base mt-1" max={businessDate()} value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} />
          </label>
          <label className="text-xs font-semibold">Note
            <input id="expNotes" className="input-base mt-1" maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          <button id="expSave" type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-60">Record expense</button>
        </form>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold">From<input type="date" className="input-base mt-1" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs font-semibold">To<input type="date" className="input-base mt-1" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="text-xs font-semibold">Category<select className="input-base mt-1" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label className="text-xs font-semibold">Paid by<select className="input-base mt-1" value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}><option value="">All methods</option>{MODES.map((mode) => <option key={mode}>{mode}</option>)}</select></label>
        {data && <div className="ml-auto text-sm">Total <b className="font-mono">{money(data.total)}</b> · {data.count} expense{data.count === 1 ? '' : 's'}{data.voidedCount > 0 && <span className="text-gray-500"> · {data.voidedCount} voided</span>}</div>}
      </div>

      {data && data.totalsByCategory.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {data.totalsByCategory.map((c) => <span key={c.category} className="px-2 py-1 rounded-full border dark:border-gray-700">{c.category} <b className="font-mono">{money(c.total)}</b></span>)}
        </div>
      )}

      <div className="overflow-x-auto border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500">
            <th className="px-3 py-2">Date</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Paid by</th>
            <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Note</th><th className="px-3 py-2" />
          </tr></thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">No expenses match these filters.</td></tr>}
            {visible.map((x) => (
              <tr key={x.id} className={`border-t dark:border-gray-700 ${x.voidedAt ? 'text-gray-400 line-through' : ''}`}>
                <td className="px-3 py-2 whitespace-nowrap">{x.expenseDate}</td>
                <td className="px-3 py-2">{x.category}</td>
                <td className="px-3 py-2">{x.paymentMode}</td>
                <td className="px-3 py-2 text-right font-mono">{money(x.amount)}</td>
                <td className="px-3 py-2 no-underline">{x.voidedAt ? <span className="not-italic" title={x.voidReason ?? ''}>VOID - {x.voidReason}</span> : x.notes}</td>
                <td className="px-3 py-2 text-right">
                  {canPost && !x.voidedAt && <button type="button" className="underline text-red-600" onClick={() => voidIt(x)}>Void</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
