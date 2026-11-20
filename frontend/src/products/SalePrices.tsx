/**
 * SalePrices — every sale type's price for every product in ONE table (managers).
 * Walk-in (the default type) is the product's MRP, edited with "Edit MRP" above; every other type (Janata, ...) has its own
 * price per product. A blank price means the product is not sold under that type. Each change is audited server-side.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth, userCan } from '../auth/AuthProvider';

interface SaleType { id: string; code: string; name: string; isDefault: boolean; isActive: boolean; enabled: boolean }
interface Row {
  id: string; name: string; brand: string; volumeMl: number | null; packQuantity: number | null; exciseCode: string | null;
  mrp: string; prices: Record<string, string>; branchPrices?: Record<string, string>;
  costPrice?: string | null; stockQuantity?: number;
}
interface Matrix { types: SaleType[]; products: Row[] }

import { showToast } from '../lib/print';

const toast = (msg: string, type: 'success' | 'error' = 'success') => {
  showToast(msg, type);
};

export function SalePrices({ branchId }: { branchId: string }) {
  const { user } = useAuth();
  const canSeeCost = userCan(user, 'cost.view');
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});     // `${productId}|${typeId}` → typed value
  const [filter, setFilter] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [newType, setNewType] = useState('');
  const [saving, setSaving] = useState(false);
  // 'business' edits the business-wide price of each sale type; 'branch' edits only this outlet's own price (blank = use the selling price)
  const [scope, setScope] = useState<'business' | 'branch'>('business');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setMatrix(await api.get<Matrix>(`/sale-types/${branchId}/prices`));
      setEdits({});
    } catch (e: any) {
      setLoadError(e.message ?? 'Failed to load prices');
      toast('Could not load prices: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const priced = useMemo(() => (matrix?.types ?? []).filter((t) => !t.isDefault), [matrix]);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (matrix?.products ?? []).filter((p) => {
      if (inStockOnly && (p.stockQuantity ?? 0) <= 0) return false;
      if (!q) return true;
      return `${p.name} ${p.brand} ${p.exciseCode ?? ''}`.toLowerCase().includes(q);
    });
  }, [matrix, filter, inStockOnly]);

  const key = (p: string, t: string) => `${p}|${t}`;
  const savedOf = (p: Row | undefined, tid: string) => (scope === 'branch' ? p?.branchPrices?.[tid] : p?.prices[tid]) ?? '';
  const valueOf = (p: Row, t: SaleType) => edits[key(p.id, t.id)] ?? savedOf(p, t.id);
  const changes = Object.entries(edits).filter(([k, v]) => {
    const [pid, tid] = k.split('|');
    return v.trim() !== savedOf(matrix?.products.find((p) => p.id === pid), tid);
  });

  const save = async () => {
    const prices = changes.map(([k, v]) => {
      const [productId, saleTypeId] = k.split('|');
      return { productId, saleTypeId, price: v.trim() === '' ? null : Number(v).toFixed(2) };
    });
    const bad = prices.find((p) => p.price !== null && !(Number(p.price) > 0));
    if (bad) { toast('Prices must be greater than zero (leave blank to stop selling under that type).', 'error'); return; }
    setSaving(true);
    try {
      const res = scope === 'business'
        ? await api.put<{ changed: number }>(`/sale-types/${branchId}/prices`, { prices })
        : await api.put<{ updated: number; removed: number }>(`/catalog/branches/${branchId}/prices`, { rows: prices }).then((r) => ({ changed: r.updated + r.removed }));
      toast(`${res.changed} price(s) saved.`);
      await load();
    } catch (e: any) {
      toast('Save failed: ' + e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const addType = async () => {
    const name = newType.trim();
    if (name.length < 2) return;
    try {
      await api.post(`/sale-types/${branchId}`, { name });
      setNewType('');
      toast(`${name} added.`);
      await load();
    } catch (e: any) {
      toast('Could not add: ' + e.message, 'error');
    }
  };

  if (loading && !matrix) {
    return (
      <div className="card mb-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 rounded shadow p-6 text-center text-sm text-gray-500">
        Loading sale type prices…
      </div>
    );
  }

  if (loadError && !matrix) {
    return (
      <div className="card mb-4 bg-white dark:bg-gray-800 border border-red-200 dark:border-red-800 text-gray-900 dark:text-gray-100 rounded shadow p-4 text-center text-sm text-red-600">
        Could not load sale type prices: {loadError}
      </div>
    );
  }

  if (!matrix) return null;

  return (
    <details className="card mgr-only mb-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 rounded shadow p-4" id="salePrices" open>
      <summary className="font-semibold text-sm cursor-pointer select-none">Prices by sale type</summary>
      <div className="pt-3 space-y-3">
        <p className="text-xs text-gray-500">
          Walk-in is the product's MRP. By default, Janata and other counters use the Walk-in price (MRP). Enter a custom price below to override it for that counter. (Enable or disable sale counters in Staff & Terminals).
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {matrix.types.map((t) => (
            <span key={t.id} className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border ${t.enabled ? 'bg-purple-50 text-purple-800 border-purple-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
              {t.name}{t.isDefault ? ' (default)' : ''}
              {!t.isDefault && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${t.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                  {t.enabled ? 'Active' : 'Disabled'}
                </span>
              )}
            </span>
          ))}
          <input
            className="p-1.5 border rounded text-sm w-40 bg-white dark:bg-gray-900"
            placeholder="New sale type…"
            aria-label="New sale type name"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addType(); }}
          />
          <button type="button" className="px-3 py-1.5 rounded border bg-gray-100 hover:bg-gray-200 text-sm cursor-pointer" onClick={addType} disabled={newType.trim().length < 2}>Add</button>
        </div>

        {priced.length === 0 ? (
          <div className="text-sm text-gray-500">No extra sale type yet — add one above.</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Whose price">
              <span className="text-gray-500">Editing:</span>
              {([['business', 'Selling price (all outlets)'], ['branch', 'This outlet only']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => { if (changes.length === 0 || window.confirm('Discard the unsaved changes?')) { setEdits({}); setScope(k); } }}
                  className={`px-3 py-1 rounded-full border font-semibold cursor-pointer ${scope === k ? 'bg-purple-600 text-white border-purple-600' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>{label}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  className="p-2 border rounded text-sm w-64 bg-white dark:bg-gray-900"
                  placeholder="Filter products…"
                  aria-label="Filter products"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    id="salePricesInStock"
                    checked={inStockOnly}
                    onChange={(e) => setInStockOnly(e.target.checked)}
                  />
                  In stock only
                </label>
              </div>
              <div className="flex items-center gap-2">
                {changes.length > 0 && <span className="text-xs text-amber-700 font-medium">{changes.length} unsaved change{changes.length > 1 ? 's' : ''}</span>}
                <button type="button" id="salePricesSave" className="px-4 py-2 rounded bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium disabled:opacity-50 cursor-pointer" disabled={changes.length === 0 || saving} onClick={save}>
                  {saving ? 'Saving…' : 'Save prices'}
                </button>
              </div>
            </div>

            <div className="overflow-x-auto border rounded">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900/40 border-b">
                    <th className="py-2 px-3">Product</th>
                    <th className="py-2 px-3 text-right">Stock</th>
                    {canSeeCost && <th className="py-2 px-3 text-right">Cost (₹)</th>}
                    <th className="py-2 px-3 text-right">Walk-in (MRP)</th>
                    {priced.map((t) => <th key={t.id} className="py-2 px-3 text-right">{t.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={canSeeCost ? 4 + priced.length : 3 + priced.length} className="p-6 text-center text-sm text-gray-500">
                        {inStockOnly ? 'No in-stock products match.' : 'No products found.'}
                      </td>
                    </tr>
                  )}
                  {rows.map((p) => {
                    const cost = p.costPrice ? parseFloat(p.costPrice) : null;
                    const walkInPrice = parseFloat(p.mrp);
                    const walkInMargin = (canSeeCost && cost && walkInPrice > 0) ? ((walkInPrice - cost) / walkInPrice) * 100 : null;
                    return (
                      <tr key={p.id} className="border-b" data-product={p.id}>
                        <td className="py-1.5 px-3">
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-gray-500">{[p.volumeMl ? `${p.volumeMl} ml` : null, p.exciseCode ? `code ${p.exciseCode}` : null].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-xs">
                          <span className={(p.stockQuantity ?? 0) > 0 ? 'font-bold text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}>
                            {p.stockQuantity ?? 0}
                          </span>
                        </td>
                        {canSeeCost && (
                          <td className="py-1.5 px-3 text-right font-mono text-xs">
                            {cost ? `₹${cost.toFixed(2)}` : <span className="text-gray-400">—</span>}
                          </td>
                        )}
                        <td className="py-1.5 px-3 text-right font-mono">
                          <div>₹{walkInPrice.toFixed(2)}</div>
                          {walkInMargin !== null && (
                            <div className={`text-[10px] font-bold mt-0.5 ${walkInMargin >= 20 ? 'text-emerald-600 dark:text-emerald-400' : walkInMargin >= 10 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {walkInMargin.toFixed(1)}% margin
                            </div>
                          )}
                        </td>
                        {priced.map((t) => {
                          const typed = edits[key(p.id, t.id)];
                          const dirty = typed !== undefined && typed.trim() !== savedOf(p, t.id);
                          const shown = scope === 'branch' ? (p.prices[t.id] ?? p.mrp) : p.mrp;
                          const currentVal = valueOf(p, t);
                          const currentPrice = currentVal.trim() !== '' ? parseFloat(currentVal) : parseFloat(shown);
                          const margin = (canSeeCost && cost && currentPrice > 0) ? ((currentPrice - cost) / currentPrice) * 100 : null;
                          return (
                            <td key={t.id} className="py-1.5 px-3 text-right">
                              <input
                                inputMode="decimal"
                                className={`w-28 p-1 border rounded text-right font-mono bg-white dark:bg-gray-900 ${dirty ? 'border-amber-400 bg-amber-50' : ''}`}
                                aria-label={`${t.name} price for ${p.name}`}
                                placeholder={`₹${parseFloat(shown).toFixed(2)}`}
                                title={scope === 'branch' ? `Blank = this outlet uses the selling price (₹${parseFloat(shown).toFixed(2)})` : `Default price is Walk-in MRP (₹${parseFloat(p.mrp).toFixed(2)})`}
                                value={currentVal}
                                onChange={(e) => setEdits({ ...edits, [key(p.id, t.id)]: e.target.value.replace(/[^\d.]/g, '') })}
                              />
                              {margin !== null && (
                                <div className={`text-[10px] font-bold mt-0.5 ${margin >= 20 ? 'text-emerald-600 dark:text-emerald-400' : margin >= 10 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}`}>
                                  {margin.toFixed(1)}% margin
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
