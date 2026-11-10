/**
 * StockSplit — divide the shop's stock between its sale types (Walk-in, Janata, ...).
 * Inventory is the source of truth: approved invoices add to the shop total, which lands in Walk-in. Here a manager decides
 * how many bottles each other counter should hold; Walk-in keeps the rest, and bottles can be taken back at any time.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

interface SaleType { id: string; code: string; name: string; isDefault: boolean }
interface CounterData { types: SaleType[]; products: { productId: string; total: number; counters: Record<string, number> }[] }
interface StockInfo { productId: string; name: string; brand?: string; volumeMl?: number | null }
interface PriceData { products: { id: string; prices: Record<string, string> }[] }

import { showToast } from '../lib/print';

const toast = (msg: string, type: 'success' | 'error' = 'success') => {
  showToast(msg, type);
};

export function StockSplit({ branchId, stockRows }: { branchId: string; stockRows: StockInfo[] }) {
  const [data, setData] = useState<CounterData | null>(null);
  const [prices, setPrices] = useState<Record<string, Record<string, string>>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});   // `${productId}|${typeId}` → bottles typed
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        api.get<CounterData>(`/sale-types/${branchId}/stock`),
        api.get<PriceData>(`/sale-types/${branchId}/prices`),
      ]);
      setData(c);
      setPrices(Object.fromEntries(p.products.map((x) => [x.id, x.prices])));
      setEdits({});
    } catch (e: any) {
      toast('Could not load the stock split: ' + e.message, 'error');
    }
  }, [branchId]);
  useEffect(() => { void load(); }, [load, stockRows.length]);

  const others = useMemo(() => (data?.types ?? []).filter((t) => !t.isDefault), [data]);
  const walkIn = useMemo(() => (data?.types ?? []).find((t) => t.isDefault), [data]);
  const names = useMemo(() => new Map(stockRows.map((s) => [s.productId, s])), [stockRows]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.products ?? [])
      .filter((r) => r.total > 0 || others.some((t) => (r.counters[t.id] ?? 0) > 0))
      .map((r) => ({ ...r, info: names.get(r.productId) }))
      .filter((r) => r.info && (!q || `${r.info.name} ${r.info.brand ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => a.info!.name.localeCompare(b.info!.name));
  }, [data, others, names, filter]);

  const key = (p: string, t: string) => `${p}|${t}`;
  const typed = (productId: string, t: SaleType, current: number): number => {
    const raw = edits[key(productId, t.id)];
    if (raw === undefined || raw.trim() === '') return current;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : current;
  };
  const changed = Object.keys(edits).filter((k) => {
    const [pid, tid] = k.split('|');
    const r = data?.products.find((x) => x.productId === pid);
    return r !== undefined && typed(pid, others.find((t) => t.id === tid)!, r.counters[tid] ?? 0) !== (r.counters[tid] ?? 0);
  });

  const hasOverAllocation = useMemo(() => {
    if (!data) return false;
    for (const r of data.products) {
      const explicit = others.reduce((s, t) => s + typed(r.productId, t, r.counters[t.id] ?? 0), 0);
      if (explicit > r.total) return true;
    }
    return false;
  }, [data, others, edits]);

  const save = async () => {
    // Validate that no product has more bottles allocated than available in stock
    for (const pid of new Set(changed.map((k) => k.split('|')[0]))) {
      const r = data?.products.find((x) => x.productId === pid);
      if (!r) continue;
      const totalWanted = others.reduce((sum, t) => sum + typed(pid, t, r.counters[t.id] ?? 0), 0);
      if (totalWanted > r.total) {
        const prodName = names.get(pid)?.name ?? 'Product';
        toast(`Cannot allocate ${totalWanted} bottles for "${prodName}". Only ${r.total} bottles available in total stock.`, 'error');
        return;
      }
    }

    const allocations = changed.map((k) => {
      const [productId, saleTypeId] = k.split('|');
      return { productId, saleTypeId, quantity: typed(productId, others.find((t) => t.id === saleTypeId)!, 0) };
    });
    setSaving(true);
    try {
      const res = await api.put<{ moved: number }>(`/sale-types/${branchId}/allocation`, { allocations });
      toast(`Stock divided — ${res.moved} change(s) saved.`);
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
      await load();
    } catch (e: any) {
      toast('Could not divide the stock: ' + e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!data || others.length === 0) return null;

  return (
    <details className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 p-4" id="stockSplit" open>
      <summary className="font-semibold text-sm cursor-pointer select-none">Split stock between sale types</summary>
      <div className="pt-3 space-y-3">
        <p className="text-xs text-gray-500">
          The total is what inventory holds (invoices add to it). Set how many bottles each counter should hold — {walkIn?.name ?? 'Walk-in'} keeps the
          rest. Lower a number to take bottles back. Allocations cannot exceed total stock in inventory.
        </p>
        {hasOverAllocation && (
          <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg text-xs font-semibold text-red-700 dark:text-red-300">
            ⚠️ Some products have more bottles allocated across counters than total stock available. Adjust quantities before saving.
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <input
            className="p-2 border rounded text-sm w-64 bg-white dark:bg-slate-950"
            placeholder="Filter products…"
            aria-label="Filter products"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="flex items-center gap-2">
            {changed.length > 0 && <span className="text-xs text-amber-700 font-medium">{changed.length} unsaved</span>}
            <button type="button" id="stockSplitSave" className="px-4 py-2 rounded bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium disabled:opacity-50 cursor-pointer" disabled={changed.length === 0 || saving || hasOverAllocation} onClick={save}>
              {saving ? 'Saving…' : 'Save split'}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="bg-gray-50 dark:bg-slate-950/40 border-b">
                <th className="py-2 px-3">Product</th>
                <th className="py-2 px-3 text-right">Total in inventory</th>
                <th className="py-2 px-3 text-right">{walkIn?.name ?? 'Walk-in'} (rest)</th>
                {others.map((t) => <th key={t.id} className="py-2 px-3 text-right">{t.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const explicit = others.reduce((s, t) => s + typed(r.productId, t, r.counters[t.id] ?? 0), 0);
                const rest = r.total - explicit;
                return (
                  <tr key={r.productId} className="border-b" data-product={r.productId}>
                    <td className="py-1.5 px-3">
                      <div className="font-medium">{r.info!.name}</div>
                      {r.info!.volumeMl ? <div className="text-xs text-gray-500">{r.info!.volumeMl} ml</div> : null}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono font-bold">{r.total}</td>
                    <td className={`py-1.5 px-3 text-right font-mono ${rest < 0 ? 'text-red-600 font-bold' : ''}`} title={rest < 0 ? 'More than the shop holds' : undefined}>{rest}</td>
                    {others.map((t) => {
                      const current = r.counters[t.id] ?? 0;
                      const priced = !!prices[r.productId]?.[t.id];
                      return (
                        <td key={t.id} className="py-1.5 px-3 text-right">
                          <input
                            type="number"
                            min="0"
                            className="w-24 p-1 border rounded text-right font-mono bg-white dark:bg-slate-950 disabled:opacity-50"
                            aria-label={`${t.name} bottles of ${r.info!.name}`}
                            disabled={!priced && current === 0}
                            title={!priced && current === 0 ? `Set a ${t.name} price first (Products → Prices by sale type)` : undefined}
                            value={edits[key(r.productId, t.id)] ?? String(current)}
                            onChange={(e) => setEdits({ ...edits, [key(r.productId, t.id)]: e.target.value })}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
