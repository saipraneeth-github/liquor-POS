import { useState, useEffect, useCallback, useMemo } from 'react';
import { getCategoryInfo } from '../components/category-icons';
import { Package, PackageOpen, Trash2, ArrowLeftRight } from 'lucide-react';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { ProtectedButton, Modal } from '../components/ui';
import { api } from '../api/client';
import { useAuth, isManagerLike, userCan } from '../auth/AuthProvider';
import { showToast } from '../lib/print';
import { StockSplit } from './StockSplit';
import { StockByType } from './StockByType';

interface StockRow {
  productId: string;
  name: string;
  brand?: string;
  volumeMl?: number;
  packQuantity?: number;
  quantity: number;
  openMl?: number;
  reorderLevel: number;
  mrp: string;
  costPrice?: string;
  previousCostPrice?: string;
  costPerCase?: string;
  lastInvoiceNumber?: string;
  lastInvoiceDate?: string;
  categoryId?: string;
}

interface Product {
  id: string;
  name: string;
  barcode?: string;
  sku?: string;
  costPrice?: string;
  previousCostPrice?: string;
  costPerCase?: string;
  lastInvoiceNumber?: string;
  lastInvoiceDate?: string;
  costUpdatedAt?: string;
  mrp: string;
  categoryId?: string;
  categoryName?: string;
  packQuantity?: number;
  volumeMl?: number;
  isActive: boolean;
  isAvailable?: boolean;
  trackStock?: boolean;
}

interface BreakageRow {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  reason: string;
  costValue: string;
  createdAt: string;
}

export function Inventory() {
  const { user, branches, activeBranchId } = useAuth();
  const branchId = activeBranchId ?? user?.branchId ?? branches?.[0]?.id;
  const isManager = isManagerLike(user);
  const canSeeCost = userCan(user, 'cost.view');
  const canMove = userCan(user, 'stock.move');

  // Navigation tab: 'current' = Current Store Stock & Breakage, 'counters' = Move Stock (Counters)
  const [activeTab, setActiveTab] = useState<'current' | 'counters'>('current');

  // Store Stock State
  const [stockRows, setStockRows] = useState<StockRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingStock, setLoadingStock] = useState(false);
  const [stockSearch, setStockSearch] = useState('');
  const [stockCategoryFilter, setStockCategoryFilter] = useState<string>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'low' | 'out'>('all');
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Breakage State
  const [showBreakage, setShowBreakage] = useState(false);
  const [breakProduct, setBreakProduct] = useState('');
  const [breakQty, setBreakQty] = useState('1');
  const [breakReason, setBreakReason] = useState('');
  const [breakLog, setBreakLog] = useState<BreakageRow[]>([]);

  // Confirmation Modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onOk: () => void;
  } | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  const loadStock = useCallback(async () => {
    if (!branchId) return;
    setLoadingStock(true);
    try {
      const [stockData, prodData] = await Promise.all([
        api.get<StockRow[]>(`/inventory/stock/${branchId}`),
        api.get<Product[]>(`/products?branchId=${branchId}`),
      ]);
      setStockRows(stockData || []);
      setProducts(prodData || []);
      if (!breakProduct && stockData && stockData.length > 0) {
        setBreakProduct(stockData[0].productId);
      }
    } catch (err: any) {
      showToast('Could not load inventory: ' + err.message, 'error');
    } finally {
      setLoadingStock(false);
    }
  }, [branchId, breakProduct]);

  const loadBreakage = useCallback(async () => {
    if (!branchId) return;
    try {
      const data = await api.get<BreakageRow[]>('/compliance/breakage/' + branchId);
      setBreakLog(data || []);
    } catch {
      // quiet fail
    }
  }, [branchId]);

  useEffect(() => {
    loadStock();
    if (isManager) loadBreakage();
  }, [loadStock, loadBreakage, isManager]);

  useEffect(() => {
    const handleStockUpdate = () => {
      loadStock();
      if (isManager) loadBreakage();
    };
    window.addEventListener('app:stock_updated', handleStockUpdate);
    return () => window.removeEventListener('app:stock_updated', handleStockUpdate);
  }, [loadStock, loadBreakage, isManager]);

  const handleRecordBreakage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    const qty = parseInt(breakQty, 10);
    if (isNaN(qty) || qty < 1) {
      showToast('Quantity must be at least 1 bottle.', 'error');
      return;
    }
    if (breakReason.trim().length < 3) {
      showToast('Please give a short reason (at least 3 characters).', 'error');
      return;
    }
    try {
      const res = await api.post<{ stockQuantity: number }>('/compliance/breakage/' + branchId, {
        productId: breakProduct,
        quantity: qty,
        reason: breakReason.trim(),
      });
      showToast(`Breakage recorded — new stock is ${res.stockQuantity} bottles.`, 'success');
      setBreakReason('');
      setBreakQty('1');
      await loadStock();
      if (isManager) loadBreakage();
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
    } catch (err: any) {
      showToast('Could not record breakage: ' + err.message, 'error');
    }
  };

  const handleClearCompleteInventory = () => {
    if (!branchId || isClearing) return;
    setConfirmModal({
      title: 'Delete Complete Store Inventory?',
      message:
        'Are you sure you want to delete all current stock, breakage logs, and bills for this store? All bottle counts will be reset to 0 so you can inward fresh stock from invoices.',
      onOk: async () => {
        setConfirmModal(null);
        setIsClearing(true);
        try {
          const res = await api.delete<{ success: boolean; deletedStock: number; deletedInvoices: number }>(
            `/inventory/stock/${branchId}/clear`
          );
          showToast(`✓ Inventory cleared: ${res.deletedStock} stock lines and ${res.deletedInvoices} bills removed.`, 'success');
          await loadStock();
          window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
        } catch (err: any) {
          showToast('Failed to clear inventory: ' + err.message, 'error');
        } finally {
          setIsClearing(false);
        }
      },
    });
  };

  // Stock Metrics
  const inStockCount = stockRows.filter((r) => r.quantity > 0).length;
  const lowCount = stockRows.filter((r) => r.quantity > 0 && r.quantity <= r.reorderLevel).length;
  const outCount = stockRows.filter((r) => r.quantity <= 0).length;
  const totalBottlesStock = stockRows.reduce((sum, r) => sum + r.quantity, 0);

  const q = stockSearch.trim().toLowerCase();
  const visibleStock = stockRows.filter((r) => {
    if (stockFilter === 'in' && r.quantity <= 0) return false;
    if (stockFilter === 'out' && r.quantity > 0) return false;
    if (stockFilter === 'low' && !(r.quantity > 0 && r.quantity <= r.reorderLevel)) return false;
    const prod = productMap.get(r.productId);
    const cat = getCategoryInfo(prod?.categoryName, r.name);
    if (stockCategoryFilter !== 'all' && cat.type !== stockCategoryFilter) return false;
    return !q || r.name.toLowerCase().includes(q) || (r.brand || '').toLowerCase().includes(q);
  });

  return (
    <section className="page active p-4 md:p-6 max-w-7xl mx-auto" id="page-inventory" aria-labelledby="inventoryTitle">
      {/* ── Top Header & Tab Navigation ────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6 pb-4 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50" id="inventoryTitle">
            Inventory Management
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {activeTab === 'current'
              ? 'Live bottle counts, costs, margins and breakage tracking for this store.'
              : 'Allocate and transfer bottle stock between Walk-in, Janata, and other counters.'}
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-1 text-sm font-medium">
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'current'
                ? 'bg-purple-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-750'
            }`}
            onClick={() => setActiveTab('current')}
          >
            <Package size={16} />
            Current Stock
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'counters'
                ? 'bg-purple-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-750'
            }`}
            onClick={() => setActiveTab('counters')}
          >
            <ArrowLeftRight size={16} />
            Move Stock (Counters)
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 1: CURRENT STORE STOCK & BREAKAGE                                  */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'current' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" id="stockStats">
            {[
              { k: 'all', label: 'All Products', val: stockRows.length, cls: 'text-gray-900 dark:text-gray-100' },
              { k: 'in', label: 'In stock', val: inStockCount, cls: 'text-emerald-600 dark:text-emerald-400' },
              { k: 'low', label: 'Low stock', val: lowCount, cls: 'text-amber-600 dark:text-amber-400' },
              { k: 'out', label: 'Out of stock', val: outCount, cls: 'text-red-600 dark:text-red-400' },
              { k: 'bottles', label: 'Bottles on hand', val: totalBottlesStock.toLocaleString('en-IN'), cls: 'text-gray-700 dark:text-gray-300' },
            ].map((s) => (
              <button
                key={s.k}
                type="button"
                disabled={s.k === 'bottles'}
                onClick={() => setStockFilter(s.k === 'bottles' ? 'all' : (stockFilter === s.k ? 'all' : s.k as any))}
                className={`text-left p-4 bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 transition-colors ${
                  stockFilter === s.k ? 'ring-2 ring-purple-500 border-purple-500' : s.k !== 'bottles' ? 'hover:border-gray-400 dark:hover:border-slate-700 cursor-pointer' : ''
                }`}
              >
                <div className="text-xs text-gray-500 dark:text-slate-400">{s.label}</div>
                <div className={`text-2xl font-bold font-display tabular-nums mt-1 ${s.cls}`}>{s.val}</div>
              </button>
            ))}
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 shadow-sm">
            {/* Streamlined Single-Row Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 border-b dark:border-slate-800 bg-gray-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-2 flex-1 min-w-[260px]">
                <input
                  className="flex-1 p-2 border dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100 placeholder-gray-400"
                  placeholder="Search product or brand…"
                  value={stockSearch}
                  onChange={(e) => setStockSearch(e.target.value)}
                />
                <select
                  value={stockCategoryFilter}
                  onChange={(e) => setStockCategoryFilter(e.target.value)}
                  className="p-2 border dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-gray-700 dark:text-slate-200 cursor-pointer font-medium"
                >
                  <option value="all">All Types</option>
                  <option value="beer">Beer</option>
                  <option value="whisky">Whisky</option>
                  <option value="wine">Wine</option>
                  <option value="vodka">Vodka</option>
                  <option value="rum">Rum</option>
                  <option value="gin">Gin</option>
                  <option value="brandy">Brandy</option>
                </select>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="inline-flex rounded-lg border dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5 text-xs">
                  {(['all', 'in', 'low', 'out'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      id={`invStockFilter-${f}`}
                      onClick={() => setStockFilter(f)}
                      className={`px-3 py-1.5 rounded-md cursor-pointer font-medium transition-colors ${
                        stockFilter === f
                          ? 'bg-purple-600 text-white font-semibold shadow-xs'
                          : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-100'
                      }`}
                    >
                      {f === 'all' ? 'All' : f === 'in' ? 'In Stock' : f === 'low' ? 'Low Stock' : 'Out of Stock'}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className="px-2.5 py-1.5 text-xs text-gray-600 hover:text-gray-900 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer border dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
                  onClick={loadStock}
                  title="Refresh store stock"
                >
                  ↻ Refresh
                </button>

                <button
                  type="button"
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border text-rose-700 border-rose-200 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 cursor-pointer transition-colors"
                  onClick={() => setShowBreakage((v) => !v)}
                >
                  {showBreakage ? '✕ Hide Breakage' : 'Record Breakage'}
                </button>

                <ProtectedButton
                  variant="danger"
                  minRole="manager"
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/60 cursor-pointer flex items-center gap-1 transition-colors"
                  onClick={handleClearCompleteInventory}
                  title="Delete all stock and previous bills to start fresh"
                >
                  <Trash2 size={13} /> Clear Store Stock
                </ProtectedButton>
              </div>
            </div>

            <div className="overflow-x-auto" id="stockTable">
              {loadingStock ? (
                <BeerBottleLoader inline size="sm" title="Loading Store Stock…" subtitle="Fetching live bottle counts, cost prices & reorder levels…" />
              ) : visibleStock.length === 0 ? (
                <div className="p-8 text-center text-gray-500 text-sm space-y-2">
                  <PackageOpen size={32} className="mx-auto text-gray-400" aria-hidden="true" />
                  <div className="font-semibold text-gray-700 dark:text-gray-300">
                    {stockRows.length === 0 ? 'No products in store stock' : 'No products match the selected filters'}
                  </div>
                  <div className="text-xs text-gray-400">
                    {stockRows.length === 0
                      ? 'Upload and confirm a supplier invoice in the "Invoice Upload" page to inward bottles into stock.'
                      : `No items found ${stockFilter !== 'all' ? `with ${stockFilter === 'in' ? 'In Stock' : stockFilter === 'low' ? 'Low Stock' : 'Out of Stock'} status` : ''}${stockCategoryFilter !== 'all' ? ` in ${stockCategoryFilter}` : ''}.`}
                  </div>
                  {stockRows.length > 0 && (
                    <button
                      type="button"
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-purple-700 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/40 dark:text-purple-300 rounded-lg cursor-pointer"
                      onClick={() => {
                        setStockSearch('');
                        setStockCategoryFilter('all');
                        setStockFilter('all');
                      }}
                    >
                      Reset filters
                    </button>
                  )}
                </div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-[11px] text-gray-500 bg-gray-50 dark:bg-gray-800 uppercase tracking-wider">
                      <th className="py-2.5 px-4">Product</th>
                      <th className="py-2.5 px-4 w-56">Stock level</th>
                      {canSeeCost && <th className="py-2.5 px-3 text-right">Cost Price</th>}
                      <th className="py-2.5 px-3 text-right">MRP</th>
                      {canSeeCost && <th className="py-2.5 px-3 text-right">Margin</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {visibleStock.map((r) => {
                      const out = r.quantity <= 0;
                      const low = !out && r.quantity <= r.reorderLevel;
                      const pct = Math.min(100, r.reorderLevel > 0 ? (r.quantity / (r.reorderLevel * 3)) * 100 : r.quantity > 0 ? 100 : 0);
                      return (
                        <tr key={r.productId} className="hover:bg-gray-50/70 dark:hover:bg-slate-800/50">
                          <td className="py-3 px-4">
                            {(() => {
                              const prod = productMap.get(r.productId);
                              const cat = getCategoryInfo(prod?.categoryName, r.name);
                              const { Icon } = cat;
                              return (
                                <div className="flex items-start gap-2.5">
                                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${cat.badgeClass}`}>
                                    <Icon size={16} />
                                  </div>
                                  <div>
                                    <div className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                                      <span>{r.name}</span>
                                    </div>
                                    <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                      <span>
                                        {r.brand || ''}
                                        {r.volumeMl ? ` · ${r.volumeMl}ml` : ''}
                                        {r.packQuantity ? ` · ${r.packQuantity}/cs` : ''}
                                      </span>
                                      {/* Price Increase/Decrease Indicator */}
                                      {(() => {
                                        const prodObj = productMap.get(r.productId);
                                        const curCost = r.costPrice ? parseFloat(r.costPrice) : (prodObj?.costPrice ? parseFloat(prodObj.costPrice) : null);
                                        const prevCost = r.previousCostPrice ? parseFloat(r.previousCostPrice) : (prodObj?.previousCostPrice ? parseFloat(prodObj.previousCostPrice) : null);
                                        if (!curCost || !prevCost || Math.abs(curCost - prevCost) < 0.001) return null;
                                        const diff = curCost - prevCost;
                                        const pctInc = prevCost > 0 ? (diff / prevCost) * 100 : 0;
                                        const isInc = diff > 0;
                                        const invNum = r.lastInvoiceNumber || prodObj?.lastInvoiceNumber;
                                        return (
                                          <span
                                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-bold font-mono cursor-help ${
                                              isInc
                                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                                            }`}
                                            title={`Cost ${isInc ? 'increased' : 'decreased'}: ₹${prevCost.toFixed(2)} ➔ ₹${curCost.toFixed(2)} (${isInc ? '+' : ''}₹${diff.toFixed(2)}, ${isInc ? '+' : ''}${pctInc.toFixed(1)}%)${invNum ? ` from Inv #${invNum}` : ''}`}
                                          >
                                            {isInc ? '▲' : '▼'} {isInc ? '+' : ''}{pctInc.toFixed(0)}%
                                          </span>
                                        );
                                      })()}
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <span className={`font-mono font-semibold w-10 text-right ${out ? 'text-red-600' : low ? 'text-amber-600' : 'text-gray-900 dark:text-gray-100'}`}>
                                {r.quantity}
                              </span>
                              {!!r.openMl && r.volumeMl && (
                                <span className="open-ml text-[11px] text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-2 py-0.5 whitespace-nowrap" title="Opened bottle, poured by the peg">
                                  +{r.openMl} ml open
                                </span>
                              )}
                              <div className="flex-1 h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden" title={`Reorder at ${r.reorderLevel}`}>
                                <div className={`h-full ${out ? 'bg-red-500' : low ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                              </div>
                              {(out || low) && (
                                <span className={`text-[11px] font-semibold ${out ? 'text-red-600' : 'text-amber-600'}`}>{out ? 'Out' : 'Low'}</span>
                              )}
                            </div>
                          </td>
                          {canSeeCost && <td className="py-3 px-3 text-right">
                            {(() => {
                              const prodObj = productMap.get(r.productId);
                              const cost = r.costPrice || prodObj?.costPrice;
                              const caseCost = r.costPerCase || prodObj?.costPerCase;
                              if (!cost) return <span className="text-gray-400 text-xs">—</span>;
                              return (
                                <div>
                                  <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
                                    ₹{parseFloat(cost).toFixed(2)}
                                  </span>
                                  {caseCost && (
                                    <div className="text-[10px] text-gray-500 font-mono">
                                      ₹{parseFloat(caseCost).toFixed(0)}/cs
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>}
                          <td className="py-3 px-3 text-right font-mono font-bold text-gray-900 dark:text-gray-100">
                            ₹{parseFloat(r.mrp).toFixed(2)}
                          </td>
                          {canSeeCost && <td className="py-3 px-3 text-right">
                            {(() => {
                              const prodObj = productMap.get(r.productId);
                              const cost = r.costPrice ? parseFloat(r.costPrice) : (prodObj?.costPrice ? parseFloat(prodObj.costPrice) : null);
                              const mrp = parseFloat(r.mrp);
                              if (!cost || !mrp) return <span className="text-gray-400 text-xs">—</span>;
                              const margin = ((mrp - cost) / mrp) * 100;
                              return (
                                <span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                  margin >= 20
                                    ? 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/30'
                                    : 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30'
                                }`}>
                                  {margin.toFixed(1)}%
                                </span>
                              );
                            })()}
                          </td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {showBreakage && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 p-5 space-y-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Record broken bottle</h3>
                <form onSubmit={handleRecordBreakage} className="space-y-3">
                  <select
                    id="breakProduct"
                    aria-label="Product"
                    className="w-full p-2 border dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100"
                    value={breakProduct}
                    onChange={(e) => setBreakProduct(e.target.value)}
                    required
                  >
                    {stockRows.map((r) => (
                      <option key={r.productId} value={r.productId}>
                        {r.name} ({r.quantity} in stock)
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-[100px_1fr] gap-3">
                    <input
                      id="breakQty"
                      aria-label="Broken bottles"
                      type="number"
                      min="1"
                      className="p-2 border dark:border-slate-700 rounded-lg text-sm font-mono bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100"
                      value={breakQty}
                      onChange={(e) => setBreakQty(e.target.value)}
                      required
                    />
                    <input
                      id="breakReason"
                      aria-label="Reason"
                      className="p-2 border dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100"
                      placeholder="Reason, e.g. slipped while shelving"
                      value={breakReason}
                      onChange={(e) => setBreakReason(e.target.value)}
                      required
                      minLength={3}
                    />
                  </div>
                  <button
                    id="breakSubmit"
                    type="submit"
                    className="w-full min-h-[40px] bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-sm cursor-pointer transition-colors"
                  >
                    Record breakage
                  </button>
                </form>
              </div>

              {isManager && (
                <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Breakage, last 30 days</h3>
                  <div id="breakLog" className="overflow-x-auto max-h-64 overflow-y-auto">
                    {breakLog.length === 0 ? (
                      <div className="p-6 text-center text-gray-400 text-xs">No breakage recorded.</div>
                    ) : (
                      <table className="w-full text-left text-xs">
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                          {breakLog.map((b) => (
                            <tr key={b.id}>
                              <td className="py-2 pr-2 text-gray-500 whitespace-nowrap">
                                {new Date(b.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                              </td>
                              <td className="py-2 pr-2">
                                <div className="font-medium text-gray-900 dark:text-gray-100">{b.productName}</div>
                                <div className="text-gray-500 truncate max-w-[220px]">{b.reason}</div>
                              </td>
                              <td className="py-2 text-right font-mono">
                                ×{b.quantity}
                                <div className="text-gray-500">₹{parseFloat(b.costValue).toFixed(0)}</div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 2: MOVE STOCK (COUNTERS & SALE TYPES)                              */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'counters' && (
        <div className="space-y-6">
          {branchId && (
            <StockByType
              branchId={branchId}
              canMove={canMove}
              reloadKey={stockRows.reduce((s, r) => s + r.quantity, 0)}
              stockRows={stockRows.map((r) => ({
                productId: r.productId,
                name: r.name,
                brand: r.brand,
                volumeMl: r.volumeMl,
                reorderLevel: r.reorderLevel,
                mrp: r.mrp,
              }))}
            />
          )}

          {canMove && branchId && (
            <StockSplit
              branchId={branchId}
              stockRows={stockRows.map((r) => ({
                productId: r.productId,
                name: r.name,
                brand: r.brand,
                volumeMl: r.volumeMl,
              }))}
            />
          )}
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <Modal title={confirmModal.title} onClose={() => setConfirmModal(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">{confirmModal.message}</p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-bold cursor-pointer"
                onClick={confirmModal.onOk}
              >
                Delete Everything
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
