import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { businessDate } from '../lib/business-day';
import { errorMessage, showToast } from '../lib/print';

type Row = { productId: string; name: string; quantity: number; revenue: string; unitCost: string | null; cost: string | null; margin: string | null; marginPct: string | null };
type Report = { from: string; to: string; rows: Row[]; totals: { revenue: string; cost: string; margin: string; marginPct: string | null; withoutCost: number } };

const money = (v: string) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What each product earned over a period: revenue (net of tax and discount) less this outlet's own cost. Needs "see cost prices". */
export function Margin({ branchId }: { branchId: string }) {
  const [from, setFrom] = useState(businessDate(-29));
  const [to, setTo] = useState(businessDate());
  const [data, setData] = useState<Report | null>(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    try { setData(await api.get<Report>(`/reports/margin/${branchId}?from=${from}&to=${to}`)); }
    catch (err) { showToast(errorMessage(err), 'error'); }
  }, [branchId, from, to]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div id="marginTab" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold">From<input type="date" className="input-base mt-1" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs font-semibold">To<input type="date" className="input-base mt-1" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          {[['Revenue (net of tax)', money(data.totals.revenue)], ['Cost', money(data.totals.cost)], ['Margin', money(data.totals.margin)], ['Margin %', data.totals.marginPct ? `${data.totals.marginPct}%` : '-']].map(([l, v]) => (
            <div key={l} className="p-3 rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800"><div className="text-xs text-gray-500">{l}</div><div className="font-mono font-bold text-lg">{v}</div></div>
          ))}
        </div>
      )}
      {data && data.totals.withoutCost > 0 && <div className="text-xs p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200">{data.totals.withoutCost} product{data.totals.withoutCost === 1 ? ' has' : 's have'} no cost on record and {data.totals.withoutCost === 1 ? 'is' : 'are'} left out of the totals. Approve a supplier invoice for them to get a cost.</div>}
      <div className="overflow-x-auto border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Sold</th><th className="px-3 py-2 text-right">Revenue</th><th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">Margin</th><th className="px-3 py-2 text-right">%</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">No sales in this period.</td></tr>}
            {(data?.rows ?? []).map((r) => (
              <tr key={r.productId} className="border-t dark:border-gray-700">
                <td className="px-3 py-2">{r.name}</td><td className="px-3 py-2 text-right font-mono">{r.quantity}</td><td className="px-3 py-2 text-right font-mono">{money(r.revenue)}</td>
                <td className="px-3 py-2 text-right font-mono">{r.unitCost ? money(r.unitCost) : <span className="text-amber-700">no cost</span>}</td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${r.margin && Number(r.margin) < 0 ? 'text-red-600' : ''}`}>{r.margin ? money(r.margin) : '-'}</td>
                <td className="px-3 py-2 text-right font-mono">{r.marginPct ? `${r.marginPct}%` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
