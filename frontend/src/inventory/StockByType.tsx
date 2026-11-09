/**
 * StockByType — where the bottles are. One tab per view: All (total + a column per sale type) and one tab per sale type
 * (that counter's bottles, price and value). Inventory is the source of truth: the total is what invoices fed; the counters
 * are how it is divided. Managers can move bottles from a row and see a product's movement history per counter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { X } from 'lucide-react';

interface SaleType { id: string; code: string; name: string; isDefault: boolean }
interface CounterData { types: SaleType[]; products: { productId: string; total: number; counters: Record<string, number> }[] }
interface PriceData { products: { id: string; mrp: string; prices: Record<string, string> }[] }
export interface StockInfo { productId: string; name: string; brand?: string; volumeMl?: number | null; reorderLevel: number; mrp: string }
interface Movement { id: string; at: string; reason: string; changeQty: number; counter: string }

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const REASONS: Record<string, string> = {
  SALE: 'Sale', PURCHASE: 'Invoice received', VOID_REVERSAL: 'Void / reversal', BREAKAGE: 'Breakage', DAMAGE: 'Damage',
  COUNTER_SHEET: 'Counter count', TYPE_TRANSFER: 'Moved between counters', MANUAL_ADJUST: 'Adjustment', SCHEME_FREE_GOODS: 'Free goods',
};

const toast = (msg: string, type: 'success' | 'error' = 'success') => {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type} ${type === 'error' ? 'bg-red-600' : 'bg-emerald-600'} text-white p-3 rounded shadow`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
};

export function StockByType({ branchId, stockRows, canMove, reloadKey }: { branchId: string; stockRows: StockInfo[]; canMove: boolean; reloadKey: number }) {
  const [data, setData] = useState<CounterData | null>(null);
  const [priceOf, setPriceOf] = useState<Record<string, { mrp: string; prices: Record<string, string> }>>({});
  const [tab, setTab] = useState('ALL');
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState<'' | 'low' | 'out'>('');
  const [history, setHistory] = useState<{ productId: string; name: string; rows: Movement[] } | null>(null);
  const [move, setMove] = useState<{ productId: string; name: string; from: string; to: string; quantity: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        api.get<CounterData>(`/sale-types/${branchId}/stock`),
        api.get<PriceData>(`/sale-types/${branchId}/prices`),
      ]);
      setData(c);
      setPriceOf(Object.fromEntries(p.products.map((x) => [x.id, { mrp: x.mrp, prices: x.prices }])));
    } catch (e: any) {
      toast('Could not load stock by sale type: ' + e.message, 'error');
    }
  }, [branchId]);
  useEffect(() => { void load(); }, [load, reloadKey]);
  useEffect(() => {
    const onChange = () => { void load(); };
    window.addEventListener('app:stock_updated', onChange);
    return () => window.removeEventListener('app:stock_updated', onChange);
  }, [load]);

  const types = data?.types ?? [];
  const info = useMemo(() => new Map(stockRows.map((s) => [s.productId, s])), [stockRows]);
  const activeType = types.find((t) => t.id === tab);
  const idOf = (t: SaleType) => t.id;
  const unitPrice = (productId: string, t: SaleType): number | null => {
    const p = priceOf[productId];
    if (!p) return null;
    return t.isDefault ? parseFloat(p.mrp) : p.prices[t.id] ? parseFloat(p.prices[t.id]) : null;
  };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.products ?? [])
      .map((r) => ({ ...r, info: info.get(r.productId) }))
      .filter((r) => r.info)
      .filter((r) => !q || `${r.info!.name} ${r.info!.brand ?? ''}`.toLowerCase().includes(q))
      .filter((r) => {
        const qty = activeType ? (r.counters[activeType.id] ?? 0) : r.total;
        if (activeType && !activeType.isDefault && qty === 0 && unitPrice(r.productId, activeType) === null) return false;   // not sold there
        if (onlyIssues === 'out') return qty <= 0;
        if (onlyIssues === 'low') return qty > 0 && qty <= r.info!.reorderLevel;
        return true;
      })
      .sort((a, b) => a.info!.name.localeCompare(b.info!.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, info, search, activeType, onlyIssues, priceOf]);

  const stats = useMemo(() => {
    const list = (data?.products ?? []).filter((r) => info.get(r.productId));
    const qtyOf = (r: (typeof list)[number]) => (activeType ? (r.counters[activeType.id] ?? 0) : r.total);
    let bottles = 0; let value = 0; let low = 0; let out = 0; let lines = 0;
    for (const r of list) {
      const t = activeType;
      if (t && !t.isDefault && qtyOf(r) === 0 && unitPrice(r.productId, t) === null) continue;
      const q = qtyOf(r);
      lines++;
      bottles += q;
      const price = t ? unitPrice(r.productId, t) : parseFloat(priceOf[r.productId]?.mrp ?? '0');
      value += q * (price ?? 0);
      const lvl = info.get(r.productId)!.reorderLevel;
      if (q <= 0) out++; else if (q <= lvl) low++;
    }
    return { bottles, value, low, out, lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, info, activeType, priceOf]);

  const openHistory = async (productId: string, name: string) => {
    try {
      setHistory({ productId, name, rows: await api.get<Movement[]>(`/sale-types/${branchId}/history/${productId}`) });
    } catch (e: any) { toast('Could not load history: ' + e.message, 'error'); }
  };

  const submitMove = async () => {
    if (!move) return;
    const quantity = parseInt(move.quantity, 10);
    if (isNaN(quantity) || quantity <= 0) { toast('Enter a whole number of bottles.', 'error'); return; }
    const def = types.find((t) => t.isDefault)!;
    try {
      await api.post(`/sale-types/${branchId}/transfer`, {
        productId: move.productId,
        fromSaleTypeId: move.from === def.id ? null : move.from,
        toSaleTypeId: move.to === def.id ? null : move.to,
        quantity,
      });
      toast(`Moved ${quantity} bottle(s).`);
      setMove(null);
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
      await load();
    } catch (e: any) { toast('Could not move: ' + e.message, 'error'); }
  };

  if (!data || types.length < 2) return null;

  const card = (label: string, value: string, cls = 'text-gray-900 dark:text-gray-100') => (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold font-mono mt-0.5 ${cls}`}>{value}</div>
    </div>
  );

  return (
    <section className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 p-4 space-y-3" id="stockByType" aria-label="Stock by sale type">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-base">Where the stock is</h3>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Sale type view">
          {[{ id: 'ALL', name: 'All' }, ...types].map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              id={`sbt-${'code' in t ? (t as SaleType).code : 'ALL'}`}
              className={`px-3.5 py-1.5 rounded-full text-sm font-semibold border transition cursor-pointer ${tab === t.id ? 'bg-purple-600 text-white border-purple-600' : 'bg-white dark:bg-slate-950 text-gray-700 dark:text-gray-200 hover:bg-gray-50'}`}
              onClick={() => setTab(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {card(activeType ? `Bottles in ${activeType.name}` : 'Bottles in inventory', stats.bottles.toLocaleString('en-IN'))}
        {card(activeType ? `Value at ${activeType.name} prices` : 'Value at Walk-in (MRP) prices', inr(stats.value))}
        {card('Low stock', String(stats.low), 'text-amber-600')}
        {card('Out of stock', String(stats.out), 'text-red-600')}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className="p-2 border rounded text-sm w-64 bg-white dark:bg-slate-950" placeholder="Search products…" aria-label="Search stock" value={search} onChange={(e) => setSearch(e.target.value)} />
        {(['', 'low', 'out'] as const).map((k) => (
          <button key={k || 'all'} type="button" className={`px-3 py-1 rounded-full text-xs font-semibold border cursor-pointer ${onlyIssues === k ? 'bg-gray-800 text-white border-gray-800' : 'bg-white dark:bg-slate-950 hover:bg-gray-50'}`} onClick={() => setOnlyIssues(k)}>
            {k === '' ? `All (${stats.lines})` : k === 'low' ? `Low (${stats.low})` : `Out (${stats.out})`}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="bg-gray-50 dark:bg-slate-950/40 border-b">
              <th className="py-2 px-3">Product</th>
              {activeType ? (
                <>
                  <th className="py-2 px-3 text-right">Bottles</th>
                  <th className="py-2 px-3 text-right">Price</th>
                  <th className="py-2 px-3 text-right">Value</th>
                </>
              ) : (
                <>
                  <th className="py-2 px-3 text-right">Total</th>
                  {types.map((t) => <th key={t.id} className="py-2 px-3 text-right">{t.name}</th>)}
                </>
              )}
              <th className="py-2 px-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const lvl = r.info!.reorderLevel;
              const badge = (q: number) => (q <= 0 ? 'text-red-600 font-bold' : q <= lvl ? 'text-amber-600 font-semibold' : '');
              const q = activeType ? (r.counters[activeType.id] ?? 0) : r.total;
              const price = activeType ? unitPrice(r.productId, activeType) : null;
              return (
                <tr key={r.productId} className="border-b" data-product={r.productId}>
                  <td className="py-1.5 px-3">
                    <div className="font-medium">{r.info!.name}</div>
                    {r.info!.volumeMl ? <div className="text-xs text-gray-500">{r.info!.volumeMl} ml</div> : null}
                  </td>
                  {activeType ? (
                    <>
                      <td className={`py-1.5 px-3 text-right font-mono ${badge(q)}`}>{q}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{price === null ? '—' : `₹${price.toFixed(2)}`}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{price === null ? '—' : inr(q * price)}</td>
                    </>
                  ) : (
                    <>
                      <td className={`py-1.5 px-3 text-right font-mono font-bold ${badge(r.total)}`}>{r.total}</td>
                      {types.map((t) => <td key={t.id} className="py-1.5 px-3 text-right font-mono">{r.counters[t.id] ?? 0}</td>)}
                    </>
                  )}
                  <td className="py-1.5 px-3 text-right whitespace-nowrap">
                    <button type="button" className="text-xs text-indigo-700 underline mr-3 cursor-pointer" onClick={() => openHistory(r.productId, r.info!.name)}>History</button>
                    {canMove && (
                      <button
                        type="button"
                        className="text-xs px-2 py-1 rounded border bg-indigo-50 text-indigo-700 hover:bg-indigo-100 cursor-pointer"
                        onClick={() => {
                          const def = types.find((t) => t.isDefault)!;
                          const other = types.find((t) => !t.isDefault)!;
                          setMove({ productId: r.productId, name: r.info!.name, from: activeType && !activeType.isDefault ? activeType.id : def.id, to: activeType && !activeType.isDefault ? def.id : other.id, quantity: '' });
                        }}
                      >
                        Move
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td className="py-6 px-3 text-center text-gray-500" colSpan={types.length + 4}>Nothing to show for this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {move && (
        <div className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="sbtMoveTitle" id="sbtMove">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-5">
            <div className="flex justify-between items-start mb-3">
              <h4 className="font-bold" id="sbtMoveTitle">Move {move.name}</h4>
              <button type="button" aria-label="Close" onClick={() => setMove(null)}><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              {(['from', 'to'] as const).map((side) => (
                <label key={side} className="block text-sm font-medium">
                  {side === 'from' ? 'From' : 'To'}
                  <select className="mt-1 w-full p-2 border rounded bg-white dark:bg-gray-900" value={move[side]} onChange={(e) => setMove({ ...move, [side]: e.target.value })}>
                    {types.map((t) => <option key={t.id} value={idOf(t)}>{t.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <label className="block text-sm font-medium mb-4">
              Bottles
              <input className="mt-1 w-full p-2 border rounded font-mono bg-white dark:bg-gray-900" type="number" min="1" value={move.quantity} onChange={(e) => setMove({ ...move, quantity: e.target.value })} />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="px-4 py-2 rounded border bg-gray-100 hover:bg-gray-200" onClick={() => setMove(null)}>Cancel</button>
              <button type="button" id="sbtMoveSubmit" className="px-4 py-2 rounded bg-purple-600 hover:bg-purple-700 text-white font-medium" onClick={submitMove}>Move</button>
            </div>
          </div>
        </div>
      )}

      {history && (
        <div className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="sbtHistTitle" id="sbtHistory">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-xl w-full p-5">
            <div className="flex justify-between items-start mb-3">
              <h4 className="font-bold" id="sbtHistTitle">Movements — {history.name}</h4>
              <button type="button" aria-label="Close" onClick={() => setHistory(null)}><X size={18} /></button>
            </div>
            <div className="overflow-y-auto max-h-96 border rounded">
              <table className="w-full text-sm">
                <thead><tr className="bg-gray-50 dark:bg-slate-950/40 border-b text-left"><th className="py-1.5 px-3">When</th><th className="py-1.5 px-3">What</th><th className="py-1.5 px-3">Counter</th><th className="py-1.5 px-3 text-right">Bottles</th></tr></thead>
                <tbody>
                  {history.rows.map((m) => (
                    <tr key={m.id} className="border-b">
                      <td className="py-1.5 px-3 whitespace-nowrap">{m.at ? new Date(m.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
                      <td className="py-1.5 px-3">{REASONS[m.reason] ?? m.reason}</td>
                      <td className="py-1.5 px-3">{m.counter}</td>
                      <td className={`py-1.5 px-3 text-right font-mono ${m.changeQty < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{m.changeQty > 0 ? '+' : ''}{m.changeQty}</td>
                    </tr>
                  ))}
                  {history.rows.length === 0 && <tr><td className="py-4 px-3 text-center text-gray-500" colSpan={4}>No movements yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
