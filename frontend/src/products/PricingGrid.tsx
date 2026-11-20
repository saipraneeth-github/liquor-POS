/**
 * PricingGrid — where a business types its selling prices (managers with the "change prices" permission).
 * Two columns per product: the selling price (the same in every outlet), and (for the outlet chosen at the top) a price for
 * this outlet only, which wins there. Products with neither show "Needs price" and cannot be billed.
 * Paste or upload "sku,price" lines to fill many at once. Every change is audited.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../api/client';
import { showToast } from '../lib/print';
import { useAuth, userCan } from '../auth/AuthProvider';

interface Row {
  id: string; name: string; brand: string; volumeMl: number | null; packQuantity: number | null; exciseCode: string | null;
  sku: string | null; barcode: string | null; mrp: string; tenantPrice: string | null; branchPrice: string | null;
  effectivePrice: string | null; needsPrice: boolean; mapped: boolean;
  costPrice?: string | null; stockQuantity?: number;
}
interface Grid { unpricedCount: number; items: Row[] }

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

export function PricingGrid({ branchId, branchName, canEdit, onChanged }: { branchId: string; branchName: string; canEdit: boolean; onChanged: () => void }) {
  const { user } = useAuth();
  const canSeeCost = userCan(user, 'cost.view');
  const [grid, setGrid] = useState<Grid>({ unpricedCount: 0, items: [] });
  const [q, setQ] = useState('');
  const [unpricedOnly, setUnpricedOnly] = useState(false);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [tenantEdits, setTenantEdits] = useState<Record<string, string>>({});
  const [branchEdits, setBranchEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [pasteScope, setPasteScope] = useState<'business' | 'branch'>('business');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ branchId, limit: '2000' });
      if (q.trim()) params.set('q', q.trim());
      if (unpricedOnly) params.set('unpricedOnly', '1');
      if (inStockOnly) params.set('inStockOnly', '1');
      setGrid(await api.get<Grid>(`/catalog/pricing?${params}`));
      setTenantEdits({});
      setBranchEdits({});
    } catch (e: any) {
      setError(e.message ?? 'Could not load prices');
    } finally {
      setLoading(false);
    }
  }, [branchId, q, unpricedOnly, inStockOnly]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 250); return () => clearTimeout(t); }, [load]);

  const byId = useMemo(() => new Map(grid.items.map((r) => [r.id, r])), [grid.items]);
  const displayedItems = useMemo(() => {
    return grid.items.filter((r) => {
      if (inStockOnly && (r.stockQuantity ?? 0) <= 0) return false;
      return true;
    });
  }, [grid.items, inStockOnly]);
  const tenantChanges = Object.entries(tenantEdits).filter(([id, v]) => v.trim() !== '' && v.trim() !== (byId.get(id)?.tenantPrice ?? ''));
  const branchChanges = Object.entries(branchEdits).filter(([id, v]) => v.trim() !== (byId.get(id)?.branchPrice ?? ''));
  const invalid = [...tenantChanges, ...branchChanges].some(([, v]) => v.trim() !== '' && (!MONEY.test(v.trim()) || Number(v) <= 0));
  const pending = tenantChanges.length + branchChanges.length;

  const save = async () => {
    if (invalid) { showToast('Prices must be amounts like 850 or 850.50, above zero.', 'error'); return; }
    setSaving(true);
    try {
      if (tenantChanges.length) {
        await api.put('/catalog/prices', { branchId, rows: tenantChanges.map(([productId, v]) => ({ productId, price: Number(v).toFixed(2) })) });
      }
      if (branchChanges.length) {
        await api.put(`/catalog/branches/${branchId}/prices`, {
          rows: branchChanges.map(([productId, v]) => ({ productId, price: v.trim() === '' ? null : Number(v).toFixed(2) })),
        });
      }
      showToast(`Saved ${pending} price${pending === 1 ? '' : 's'}`, 'success');
      onChanged();
      await load();
    } catch (e: any) {
      showToast('Could not save: ' + e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const importLines = async (text: string) => {
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[,\t;]/).map((c) => c.trim()))
      .filter((c) => c.length >= 2 && MONEY.test(c[1]))
      .map((c) => ({ sku: c[0], price: Number(c[1]).toFixed(2) }));
    if (rows.length === 0) { showToast('No "sku,price" lines found.', 'error'); return; }
    setSaving(true);
    try {
      const res = pasteScope === 'business'
        ? await api.put<{ updated: number; unknown: string[] }>('/catalog/prices', { branchId, rows })
        : await api.put<{ updated: number; unknown: string[] }>(`/catalog/branches/${branchId}/prices`, { rows });
      showToast(`${res.updated} price(s) saved${res.unknown.length ? `; ${res.unknown.length} SKU(s) not found` : ''}`, res.unknown.length ? 'error' : 'success');
      setPaste('');
      onChanged();
      await load();
    } catch (e: any) {
      showToast('Import failed: ' + e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const input = 'w-28 p-1.5 text-right font-mono border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm disabled:opacity-60';

  return (
    <div className="space-y-3" id="pricingGrid">
      <div className="card p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-sm text-gray-700 dark:text-gray-300">
        The <b>selling price</b> is what a bottle is sold for at the counter, the same in every outlet. If <b>{branchName}</b> sells it at a different price, type that in its own column; leave it blank to use the selling price. The supplier invoice only records what you paid, never this price.
        {!canEdit && <div className="mt-1 text-amber-700 dark:text-amber-300">You can look at prices, but changing them needs the "change prices" permission.</div>}
      </div>

      {grid.unpricedCount > 0 && (
        <div className="card p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200" role="status">
          <b>{grid.unpricedCount}</b> product{grid.unpricedCount === 1 ? '' : 's'} have no selling price yet and cannot be billed
          (unless {branchName} has its own price).{' '}
          <button type="button" className="font-semibold underline cursor-pointer" onClick={() => setUnpricedOnly(true)}>Show only these</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input id="pricingSearch" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, brand, SKU, barcode"
            className="input p-2 pl-8 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded text-sm w-full" />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input type="checkbox" id="pricingUnpriced" checked={unpricedOnly} onChange={(e) => setUnpricedOnly(e.target.checked)} /> Needs price only
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input type="checkbox" id="pricingInStock" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} /> In stock only
        </label>
        {canEdit && (
          <button type="button" id="pricingSave" disabled={saving || pending === 0 || invalid} onClick={save}
            className="ml-auto px-4 py-2 rounded bg-purple-600 text-white text-sm font-semibold disabled:opacity-40 cursor-pointer">
            Save {pending > 0 ? `${pending} change${pending === 1 ? '' : 's'}` : 'prices'}
          </button>
        )}
      </div>

      {error && <div className="card p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700" role="alert">{error}</div>}

      <div className="card table-wrap bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow overflow-x-auto">
        <table className="table w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50">
              <th className="py-2 px-3">Product</th>
              <th className="py-2 px-3">SKU</th>
              <th className="py-2 px-3 text-right">Stock</th>
              {canSeeCost && <th className="py-2 px-3 text-right">Cost (₹)</th>}
              <th className="py-2 px-3 text-right">Selling price, all outlets (₹)</th>
              <th className="py-2 px-3 text-right">{branchName} only (₹)</th>
              <th className="py-2 px-3 text-right">Sells at</th>
              {canSeeCost && <th className="py-2 px-3 text-right">Margin %</th>}
            </tr>
          </thead>
          <tbody>
            {loading && grid.items.length === 0 && <tr><td colSpan={canSeeCost ? 8 : 6} className="p-6 text-center text-sm text-gray-500">Loading…</td></tr>}
            {!loading && displayedItems.length === 0 && <tr><td colSpan={canSeeCost ? 8 : 6} className="p-6 text-center text-sm text-gray-500">{unpricedOnly ? 'Every product has a price.' : inStockOnly ? 'No in-stock products match.' : 'No products yet. Add some from the master catalog.'}</td></tr>}
            {displayedItems.map((r) => {
              const tv = tenantEdits[r.id] ?? r.tenantPrice ?? '';
              const bv = branchEdits[r.id] ?? r.branchPrice ?? '';
              const typedBranch = bv.trim() !== '' && MONEY.test(bv.trim()) && Number(bv) > 0 ? Number(bv).toFixed(2) : r.branchPrice;
              const typedTenant = tv.trim() !== '' && MONEY.test(tv.trim()) && Number(tv) > 0 ? Number(tv).toFixed(2) : r.tenantPrice;
              const effective = typedBranch ?? typedTenant;
              const cost = r.costPrice ? parseFloat(r.costPrice) : null;
              const effPrice = effective ? parseFloat(effective) : null;
              const margin = (effPrice && effPrice > 0 && cost && cost > 0) ? ((effPrice - cost) / effPrice) * 100 : null;
              return (
                <tr key={r.id} className="border-b border-gray-200 dark:border-gray-700 text-sm text-gray-900 dark:text-gray-100">
                  <td className="py-2 px-3"><b>{r.name}</b><div className="text-xs text-gray-500">{r.brand}{r.volumeMl ? ` · ${r.volumeMl}ml` : ''}{r.packQuantity ? ` · ${r.packQuantity}/case` : ''}</div></td>
                  <td className="py-2 px-3 font-mono text-xs">{r.sku ?? '—'}</td>
                  <td className="py-2 px-3 text-right font-mono text-xs">
                    <span className={(r.stockQuantity ?? 0) > 0 ? 'font-bold text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}>
                      {r.stockQuantity ?? 0}
                    </span>
                  </td>
                  {canSeeCost && (
                    <td className="py-2 px-3 text-right font-mono text-xs">
                      {cost ? `₹${cost.toFixed(2)}` : <span className="text-gray-400">—</span>}
                    </td>
                  )}
                  <td className="py-2 px-3 text-right">
                    <input aria-label={`Selling price of ${r.name}`} inputMode="decimal" disabled={!canEdit} className={input} placeholder="—" value={tv}
                      onChange={(e) => setTenantEdits((s) => ({ ...s, [r.id]: e.target.value }))} />
                  </td>
                  <td className="py-2 px-3 text-right">
                    <input aria-label={`${branchName} price of ${r.name}`} inputMode="decimal" disabled={!canEdit} className={input} placeholder="same" value={bv}
                      onChange={(e) => setBranchEdits((s) => ({ ...s, [r.id]: e.target.value }))} />
                  </td>
                  <td className="py-2 px-3 text-right font-mono">
                    {effective ? `₹${effective}` : <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Needs price</span>}
                  </td>
                  {canSeeCost && (
                    <td className="py-2 px-3 text-right">
                      {margin !== null ? (
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-bold ${
                          margin >= 20
                            ? 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/30'
                            : margin >= 10
                            ? 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30'
                            : 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/30'
                        }`}>
                          {margin.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <details className="card bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 text-sm">
          <summary className="font-semibold cursor-pointer select-none">Paste or upload prices (SKU, price)</summary>
          <div className="pt-3 space-y-2">
            <textarea id="pricingPaste" rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'TS-5028-650,180\nTS-5030-750,1200'}
              className="w-full p-2 font-mono text-xs border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded" />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5"><input type="radio" checked={pasteScope === 'business'} onChange={() => setPasteScope('business')} /> Selling price (all outlets)</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={pasteScope === 'branch'} onChange={() => setPasteScope('branch')} /> {branchName} only</label>
              <input type="file" accept=".csv,.txt" aria-label="Upload a CSV of SKU and price" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPaste(await f.text()); }} />
              <button type="button" id="pricingImport" disabled={saving || !paste.trim()} onClick={() => importLines(paste)} className="px-3 py-1.5 rounded border border-purple-600 text-purple-700 dark:text-purple-300 font-semibold disabled:opacity-40 cursor-pointer">Apply</button>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
