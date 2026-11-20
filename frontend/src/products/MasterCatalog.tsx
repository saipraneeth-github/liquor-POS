/**
 * MasterCatalog — pick products from the state's master catalog and add them to YOUR business (managers).
 * The master list carries no prices: an added product shows as "Needs price" until you type one in Pricing.
 */
import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../api/client';
import { showToast } from '../lib/print';

interface MasterRow {
  id: string; categoryName: string; name: string; brand: string; volumeMl: number; packQuantity: number;
  exciseCode: string; sku: string; mapped: boolean; productId: string | null; needsPrice: boolean;
}
interface MasterList { total: number; items: MasterRow[] }
interface MasterUpdate { productId: string; name: string; discontinued: boolean; changes: Array<{ field: string; from: string | null; to: string | null }> }
interface MapResult { created: number; alreadyMapped: number; skipped: Array<{ masterProductId: string; reason: string }> }

const PAGE = 100;

export function MasterCatalog({ branchId, onChanged, onGoPricing }: { branchId: string; onChanged: () => void; onGoPricing: () => void }) {
  const [list, setList] = useState<MasterList>({ total: 0, items: [] });
  const [categories, setCategories] = useState<Array<{ name: string; n: number }>>([]);
  const [states, setStates] = useState<string[]>(['TS']);
  const [selectedState, setSelectedState] = useState('TS');
  const [priceStatus, setPriceStatus] = useState<'all' | 'priced' | 'unpriced'>('all');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [view, setView] = useState<'new' | 'added' | 'all'>('new');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MapResult | null>(null);
  const [updates, setUpdates] = useState<MasterUpdate[]>([]);
  const loadUpdates = useCallback(async () => {
    try { setUpdates(await api.get<MasterUpdate[]>(`/catalog/master/updates?branchId=${branchId}`)); } catch { setUpdates([]); }
  }, [branchId]);
  useEffect(() => { void loadUpdates(); }, [loadUpdates]);

  useEffect(() => {
    api.get<string[]>('/catalog/master/states')
      .then((s) => {
        if (Array.isArray(s) && s.length > 0) setStates(s);
      })
      .catch(() => setStates(['TS']));
  }, []);

  const applyUpdates = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ applied: number; skipped: Array<{ reason: string }> }>('/catalog/master/updates/apply', { branchId });
      showToast(`${r.applied} product(s) updated${r.skipped.length ? `; ${r.skipped.length} skipped: ${r.skipped[0].reason}` : ''}`, r.skipped.length ? 'error' : 'success');
      onChanged();
      await Promise.all([loadUpdates(), load()]);
    } catch (e: any) { showToast('Could not update: ' + e.message, 'error'); } finally { setBusy(false); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ branchId, limit: String(PAGE), offset: String(offset), state: selectedState });
      if (q.trim()) params.set('q', q.trim());
      if (category) params.set('category', category);
      if (view !== 'all') params.set('mapped', view === 'added' ? '1' : '0');
      if (priceStatus !== 'all') params.set('priceStatus', priceStatus);
      setList(await api.get<MasterList>(`/catalog/master?${params}`));
    } catch (e: any) {
      setError(e.message ?? 'Could not load the master catalog');
    } finally {
      setLoading(false);
    }
  }, [branchId, q, category, view, offset, selectedState, priceStatus]);

  useEffect(() => { const t = setTimeout(() => { void load(); }, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    api.get<Array<{ name: string; n: number }>>(`/catalog/master/categories?branchId=${branchId}&state=${selectedState}`)
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [branchId, selectedState]);
  useEffect(() => { setOffset(0); setSelected(new Set()); }, [q, category, view, selectedState, priceStatus]);

  const add = async (body: Record<string, unknown>, label: string) => {
    setBusy(true);
    try {
      const res = await api.post<MapResult>('/catalog/master/map', { branchId, ...body });
      setDone(res);
      setSelected(new Set());
      showToast(`${label}: ${res.created} added${res.alreadyMapped ? `, ${res.alreadyMapped} already in your catalog` : ''}`, 'success');
      onChanged();
      await load();
    } catch (e: any) {
      showToast('Could not add: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const selectable = list.items.filter((r) => !r.mapped);
  const allOnPage = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-3" id="masterCatalog">
      <div className="card p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-sm text-gray-700 dark:text-gray-300">
        The master catalog lists every product of your state with its brand, size and pack. It has <b>no prices</b>:
        add the products you stock, then type your selling prices in <button type="button" className="text-purple-600 font-semibold hover:underline cursor-pointer" onClick={onGoPricing}>Pricing</button>.
      </div>

      {updates.length > 0 && (
        <div className="card p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-900 dark:text-blue-200" id="masterUpdates" role="status">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><b>{updates.length}</b> of your products changed in the master catalog.</span>
            <button type="button" disabled={busy} onClick={() => void applyUpdates()} className="px-3 py-1.5 rounded bg-blue-600 text-white font-semibold disabled:opacity-40 cursor-pointer">Update all</button>
          </div>
          <ul className="mt-2 space-y-0.5 text-xs">
            {updates.slice(0, 8).map((u) => (
              <li key={u.productId}><b>{u.name}</b>{u.discontinued && <span className="ml-1 text-amber-700 dark:text-amber-300">(discontinued by the platform; your stock and bills stay)</span>}
                {u.changes.length > 0 && <>: {u.changes.map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`).join(', ')}</>}</li>
            ))}
            {updates.length > 8 && <li>…and {updates.length - 8} more</li>}
          </ul>
          <p className="mt-1 text-xs">Updating changes brand, size, pack, SKU, excise code and category only. Your prices, costs, stock and product names are not touched.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            id="masterSearch" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, brand, excise code, barcode"
            className="input p-2 pl-8 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded text-sm w-full"
          />
        </div>
        <select
          id="masterState"
          value={selectedState}
          onChange={(e) => { setSelectedState(e.target.value); setCategory(''); }}
          className="input p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded text-sm font-semibold"
          title="Filter by State"
        >
          {states.map((st) => (
            <option key={st} value={st}>State: {st}</option>
          ))}
        </select>
        <select id="masterCategory" value={category} onChange={(e) => setCategory(e.target.value)} className="input p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded text-sm">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.n})</option>)}
        </select>
        <select
          id="masterPriceStatus"
          value={priceStatus}
          onChange={(e) => setPriceStatus(e.target.value as any)}
          className="input p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded text-sm"
          title="Filter by Price status"
        >
          <option value="all">All price statuses</option>
          <option value="unpriced">Needs price only</option>
          <option value="priced">Priced only</option>
        </select>
        <div className="flex rounded border border-gray-300 dark:border-gray-700 overflow-hidden text-xs font-semibold" role="group" aria-label="Show">
          {([['new', 'Not added'], ['added', 'Added'], ['all', 'All']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setView(k)} className={`px-3 py-2 cursor-pointer ${view === k ? 'bg-purple-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>{label}</button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button" id="masterAddSelected" disabled={busy || selected.size === 0}
          onClick={() => add({ masterProductIds: [...selected] }, 'Selected products')}
          className="px-3 py-2 rounded bg-purple-600 text-white font-semibold disabled:opacity-40 cursor-pointer"
        >
          Add selected ({selected.size})
        </button>
        {category && (
          <button type="button" id="masterAddCategory" disabled={busy} onClick={() => add({ categoryNames: [category] }, category)} className="px-3 py-2 rounded border border-purple-600 text-purple-700 dark:text-purple-300 font-semibold disabled:opacity-40 cursor-pointer">
            Add all {category}
          </button>
        )}
        <button
          type="button" id="masterAddAll" disabled={busy}
          onClick={() => { if (window.confirm('Add every product in the master catalog to your business? You can price and deactivate them afterwards.')) void add({ all: true }, 'Master catalog'); }}
          className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-semibold disabled:opacity-40 cursor-pointer"
        >
          Add everything
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">{list.total} products</span>
      </div>

      {done && (
        <div className="card p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-900 dark:text-emerald-200" role="status">
          Added {done.created}. These products need a selling price before they can be billed.{' '}
          <button type="button" className="font-semibold underline cursor-pointer" onClick={onGoPricing}>Set prices now</button>
          {done.skipped.length > 0 && <div className="mt-1 text-amber-800 dark:text-amber-300">{done.skipped.length} could not be added: {done.skipped[0].reason}</div>}
        </div>
      )}

      {error && <div className="card p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700" role="alert">{error}</div>}

      <div className="card table-wrap bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow overflow-x-auto">
        <table className="table w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50">
              <th className="py-2 px-3 w-8">
                <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(selectable.map((r) => r.id)))} />
              </th>
              <th className="py-2 px-3">Product</th>
              <th className="py-2 px-3">Category</th>
              <th className="py-2 px-3 text-right">Size</th>
              <th className="py-2 px-3 text-right">Pack</th>
              <th className="py-2 px-3">Excise code</th>
              <th className="py-2 px-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && list.items.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-sm text-gray-500">Loading…</td></tr>}
            {!loading && list.items.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-sm text-gray-500">{list.total === 0 && !q && !category && view === 'new' ? 'Everything in the master catalog is already in your business.' : 'Nothing matches.'}</td></tr>}
            {list.items.map((r) => (
              <tr key={r.id} className="border-b border-gray-200 dark:border-gray-700 text-sm text-gray-900 dark:text-gray-100">
                <td className="py-2 px-3"><input type="checkbox" aria-label={`Select ${r.name}`} disabled={r.mapped} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="py-2 px-3"><b>{r.name}</b><div className="text-xs text-gray-500">{r.brand}</div></td>
                <td className="py-2 px-3">{r.categoryName}</td>
                <td className="py-2 px-3 text-right font-mono">{r.volumeMl} ml</td>
                <td className="py-2 px-3 text-right font-mono">{r.packQuantity}</td>
                <td className="py-2 px-3 font-mono text-xs">{r.exciseCode}</td>
                <td className="py-2 px-3">
                  {!r.mapped ? <span className="text-xs text-gray-500">Not added</span>
                    : r.needsPrice ? <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Needs price</span>
                    : <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">Added</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {list.total > PAGE && (
        <div className="flex items-center justify-between text-sm">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="px-3 py-1.5 rounded border disabled:opacity-40 cursor-pointer">Previous</button>
          <span className="text-gray-500">{offset + 1}–{Math.min(offset + PAGE, list.total)} of {list.total}</span>
          <button type="button" disabled={offset + PAGE >= list.total} onClick={() => setOffset(offset + PAGE)} className="px-3 py-1.5 rounded border disabled:opacity-40 cursor-pointer">Next</button>
        </div>
      )}
    </div>
  );
}
