import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { businessDate } from '../lib/business-day';
import { errorMessage, showToast } from '../lib/print';

type Row = {
  productId: string; name: string; brand: string | null; volumeMl: number | null; opening: number; received: number; transferIn: number; transferOut: number;
  returnedToSupplier: number; sold: number; counterSheetSales: number; breakage: number; adjustments: number; closing: number; closingLitres: number;
};
type Reg = { from: string; to: string; rows: Row[]; totals: Omit<Row, 'productId' | 'name' | 'brand' | 'volumeMl'> };
type Day = { date: string; opening: number; received: number; transferIn: number; transferOut: number; returnedToSupplier: number; sold: number; counterSheetSales: number; breakage: number; adjustments: number; closing: number };

const COLS: [keyof Row, string][] = [
  ['opening', 'Opening'], ['received', 'Received'], ['transferIn', 'Transfer in'], ['transferOut', 'Transfer out'], ['returnedToSupplier', 'Returned to supplier'],
  ['sold', 'Sold'], ['counterSheetSales', 'Sold, no bill'], ['breakage', 'Breakage'], ['adjustments', 'Adjust.'], ['closing', 'Closing'],
];

/** The stock register: every product's opening, what came in and went out, and closing for a period, with a CSV for the inspector. */
export function StockRegister({ branchId }: { branchId: string }) {
  const [from, setFrom] = useState(businessDate(-29));
  const [to, setTo] = useState(businessDate());
  const [reg, setReg] = useState<Reg | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    try { setReg(await api.get<Reg>(`/compliance/stock-audit/${branchId}/register?from=${from}&to=${to}`)); }
    catch (err) { showToast(errorMessage(err), 'error'); }
  }, [branchId, from, to]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (productId: string) => {
    if (open === productId) { setOpen(null); return; }
    setOpen(productId);
    setDays([]);
    try { setDays((await api.get<{ days: Day[] }>(`/compliance/stock-audit/${branchId}/register/${productId}?from=${from}&to=${to}`)).days); }
    catch (err) { showToast(errorMessage(err), 'error'); }
  };

  const csv = async () => {
    setDownloading(true);
    try { await api.download(`/compliance/stock-audit/${branchId}/register?from=${from}&to=${to}&format=csv`, `stock-register-${from}-to-${to}.csv`); }
    catch (err) { showToast(errorMessage(err), 'error'); } finally { setDownloading(false); }
  };

  return (
    <div id="stockRegister" className="mt-8 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">Stock register</h3>
          <div className="text-xs text-gray-500">Bottles: opening + in - out = closing, from the stock movements. Click a product for the day-by-day figures.</div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold">From<input id="srFrom" type="date" className="input-base mt-1" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-xs font-semibold">To<input id="srTo" type="date" className="input-base mt-1" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <button id="srCsv" type="button" disabled={downloading} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60" onClick={csv}>Download CSV</button>
        </div>
      </div>

      <div className="overflow-x-auto border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="px-3 py-2">Product</th>{COLS.map(([, l]) => <th key={l} className="px-2 py-2 text-right">{l}</th>)}</tr></thead>
          <tbody>
            {(reg?.rows ?? []).length === 0 && <tr><td colSpan={COLS.length + 1} className="px-3 py-6 text-center text-gray-500">No stock or movements in this period.</td></tr>}
            {(reg?.rows ?? []).map((r) => (
              <Fragment key={r.productId}>
                <tr className="border-t dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750" onClick={() => toggle(r.productId)}>
                  <td className="px-3 py-1.5 font-medium">{r.name}</td>
                  {COLS.map(([k]) => <td key={k} className={`px-2 py-1.5 text-right font-mono ${k === 'closing' ? 'font-bold' : ''}`}>{r[k] || ''}</td>)}
                </tr>
                {open === r.productId && days.map((d) => (
                  <tr key={d.date} className="bg-gray-50 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300">
                    <td className="px-3 py-1 pl-8">{d.date}</td>
                    {COLS.map(([k]) => <td key={k} className="px-2 py-1 text-right font-mono">{(d as Record<string, number | string>)[k] || ''}</td>)}
                  </tr>
                ))}
              </Fragment>
            ))}
            {reg && reg.rows.length > 0 && (
              <tr className="border-t-2 dark:border-gray-600 font-bold">
                <td className="px-3 py-2">Total ({reg.totals.closingLitres.toFixed(2)} litres at close)</td>
                {COLS.map(([k]) => <td key={k} className="px-2 py-2 text-right font-mono">{reg.totals[k as keyof Reg['totals']]}</td>)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
