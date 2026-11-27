import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { api } from '../api/client';
import { useAuth, userCan } from '../auth/AuthProvider';
import { businessDate } from '../lib/business-day';
import { errorMessage, showToast } from '../lib/print';

type Expense = {
  id: string; category: string; amount: string; paymentMode: string; expenseDate: string; notes: string | null;
  voidedAt: string | null; voidReason: string | null;
};
type ExpenseList = { expenses: Expense[]; total: string; count: number; voidedCount: number; totalsByCategory: { category: string; total: string; count: number }[] };

const money = (v: string) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });


/** Expenses of the outlet: record one, see the totals by category, void one that was entered by mistake (never deleted). */
export function Expenses({ branchId }: { branchId: string }) {
  const { user } = useAuth();
  const { t } = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const canPost = userCan(user, 'accounting.post');
  const [from, setFrom] = useState(businessDate(-30));
  const [to, setTo] = useState(businessDate());
  const [data, setData] = useState<ExpenseList | null>(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true); setError(false);
    try {
      setData(await api.get<ExpenseList>(`/expenses/${branchId}?from=${from}&to=${to}`));
    } catch {
      setError(true); setData(null);
    } finally { setLoading(false); }
  }, [branchId, from, to]);

  useEffect(() => { void load(); }, [load]);

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
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold">From<input type="date" className="input-base mt-1" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs font-semibold">To<input type="date" className="input-base mt-1" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        {data && <div className="ml-auto text-sm">Total <b className="font-mono">{money(data.total)}</b> · {data.count} expense{data.count === 1 ? '' : 's'}{data.voidedCount > 0 && <span className="text-gray-500"> · {data.voidedCount} voided</span>}</div>}
      </div>

      {data && data.totalsByCategory.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {data.totalsByCategory.map((c) => <span key={c.category} className="px-2 py-1 rounded-full border dark:border-gray-700">{c.category} <b className="font-mono">{money(c.total)}</b></span>)}
        </div>
      )}

      {loading && <p role="status">{t('Loading expenses…')}</p>}
      {error && <div role="alert"><p>{t('Could not load expenses. Try again.')}</p><button type="button" className="underline" onClick={() => void load()}>{t('Try again')}</button></div>}
      <div className="overflow-x-auto border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="accounting-stack-table w-full text-sm">
          <thead><tr className="text-left text-gray-500">
            <th className="px-3 py-2">Date</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Paid by</th>
            <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Note</th><th className="px-3 py-2" />
          </tr></thead>
          <tbody>
            {!loading && !error && (data?.expenses ?? []).length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">No expenses in this period.</td></tr>}
            {(data?.expenses ?? []).map((x) => (
              <tr key={x.id} className={`border-t dark:border-gray-700 ${x.voidedAt ? 'text-gray-400 line-through' : ''}`}>
                <td data-label={t('Date')} className="px-3 py-2 whitespace-nowrap">{x.expenseDate}</td>
                <td data-label={t('Category')} className="px-3 py-2">{x.category}</td>
                <td data-label={t('Paid by')} className="px-3 py-2">{x.paymentMode}</td>
                <td data-label={t('Amount')} className="px-3 py-2 text-right font-mono">{money(x.amount)}</td>
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
