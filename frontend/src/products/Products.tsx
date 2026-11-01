import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { CategoryBadge } from '../components/category-icons';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface Category {
  id: string;
  name: string;
}

interface Product {
  id: string;
  name: string;
  brand?: string;
  volumeMl?: number;
  packQuantity?: number;
  barcode?: string;
  sku?: string;
  mrp: string;
  costPrice?: string;
  previousCostPrice?: string;
  costPerCase?: string;
  lastInvoiceNumber?: string;
  lastInvoiceDate?: string;
  costUpdatedAt?: string;
  categoryId?: string;
  categoryName?: string;
}

export function Products() {
  const { user } = useAuth();
  const isManager = user?.role === 'manager' || user?.role === 'owner';
  const branchId = user?.branchId;

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stockMap, setStockMap] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  // Edit MRP modal
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [newMrp, setNewMrp] = useState('');
  const [savingMrp, setSavingMrp] = useState(false);

  // New product form
  const [npCategory, setNpCategory] = useState('');
  const [npName, setNpName] = useState('');
  const [npBrand, setNpBrand] = useState('');
  const [npVolume, setNpVolume] = useState('750');
  const [npPack, setNpPack] = useState('12');
  const [npMrp, setNpMrp] = useState('');
  const [npCost, setNpCost] = useState('');
  const [npBarcode, setNpBarcode] = useState('');
  const [npSku, setNpSku] = useState('');
  const [creating, setCreating] = useState(false);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type} ${type === 'error' ? 'bg-red-600' : 'bg-emerald-600'} text-white p-3 rounded shadow`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [prodRes, catRes, stockRes] = await Promise.all([
        api.get<Product[] | { products: Product[]; categories?: Category[] }>('/products'),
        api.get<Category[] | { categories: Category[] }>('/categories').catch(() => []),
        branchId ? api.get<any[]>('/inventory/stock/' + branchId).catch(() => []) : Promise.resolve([]),
      ]);

      const prodList = Array.isArray(prodRes) ? prodRes : (prodRes as any)?.products ?? [];
      setProducts(prodList);

      const catList = Array.isArray(catRes) ? catRes : (catRes as any)?.categories ?? [];
      setCategories(catList);
      if (catList.length && !npCategory) {
        setNpCategory(catList[0].id);
      }

      const sm: Record<string, number> = {};
      if (Array.isArray(stockRes)) {
        for (const s of stockRes) {
          sm[s.productId] = s.quantity;
        }
      }
      setStockMap(sm);
    } catch (err: any) {
      showToast('Failed to load products: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [branchId]);

  const handleOpenMrp = (p: Product) => {
    setEditProduct(p);
    setNewMrp(p.mrp);
  };

  const handleSaveMrp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editProduct) return;
    const mrpFloat = parseFloat(newMrp.trim());
    if (isNaN(mrpFloat) || mrpFloat <= 0) {
      showToast('Enter a valid MRP like 850 or 850.00.', 'error');
      return;
    }
    setSavingMrp(true);
    try {
      await api.patch(`/products/${editProduct.id}/mrp`, { mrp: newMrp.trim() });
      showToast('MRP updated to ₹' + mrpFloat.toFixed(2), 'success');
      setEditProduct(null);
      await loadData();
    } catch (err: any) {
      showToast('MRP update failed: ' + err.message, 'error');
    } finally {
      setSavingMrp(false);
    }
  };

  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    const mrpVal = npMrp.trim();
    if (isNaN(parseFloat(mrpVal)) || parseFloat(mrpVal) <= 0) {
      showToast('MRP must be an amount like 850 or 850.00.', 'error');
      return;
    }
    const body: any = {
      categoryId: npCategory,
      name: npName.trim(),
      brand: npBrand.trim(),
      mrp: mrpVal,
    };
    if (npVolume) body.volumeMl = parseInt(npVolume, 10);
    if (npPack) body.packQuantity = parseInt(npPack, 10);
    if (npCost.trim()) body.costPrice = npCost.trim();
    if (npBarcode.trim()) body.barcode = npBarcode.trim();
    if (npSku.trim()) body.sku = npSku.trim();

    setCreating(true);
    try {
      await api.post('/products', body);
      showToast('Product created: ' + body.name, 'success');
      setNpName('');
      setNpBrand('');
      setNpMrp('');
      setNpCost('');
      setNpBarcode('');
      setNpSku('');
      await loadData();
    } catch (err: any) {
      showToast('Could not create product: ' + err.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const q = search.trim().toLowerCase();
  const filtered = (products || []).filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.brand || '').toLowerCase().includes(q) ||
      (p.barcode || '').includes(q)
  );

  return (
    <section className="page active" id="page-products" aria-labelledby="prodTitle">
      <div className="row between flex justify-between items-center mb-4">
        <div>
          <h2 className="h1 text-xl font-bold text-gray-900 dark:text-gray-100" id="prodTitle">🍷 Product Catalog</h2>
          <div className="muted small text-xs text-gray-500 dark:text-gray-400">
            MRP is set here (manager+) and every change is audited. Prices cannot be changed at the counter.
          </div>
        </div>
      </div>

      <div className="row mb-4">
        <label htmlFor="prodSearch" className="sr-only">Search products</label>
        <input
          id="prodSearch"
          className="input p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded text-sm w-full max-w-xs focus:ring-2 focus:ring-primary/20 focus:outline-none"
          style={{ maxWidth: '320px' }}
          placeholder="Search name, brand or barcode"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card table-wrap bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow overflow-x-auto mb-6" id="prodTable">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading products…</div>
        ) : filtered.length === 0 ? (
          <div className="state p-8 text-center text-gray-500 dark:text-gray-400">
            {products.length ? 'No products match.' : 'No products yet.'}
          </div>
        ) : (
          <table className="table w-full text-left">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50">
                <th className="py-2 px-3">Product</th>
                <th className="py-2 px-3">Category</th>
                <th className="py-2 px-3">Barcode</th>
                <th className="py-2 px-3 text-right">Cost Price</th>
                <th className="py-2 px-3 text-right">MRP</th>
                <th className="py-2 px-3 text-right">Margin</th>
                <th className="py-2 px-3 text-right">Stock</th>
                {isManager && <th className="py-2 px-3"></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 text-sm text-gray-900 dark:text-gray-100">
                  <td className="py-2 px-3">
                    <b>{p.name}</b>
                    <div className="muted small text-xs text-gray-500 dark:text-gray-400">
                      {p.brand || ''}
                      {p.volumeMl ? ` · ${p.volumeMl}ml` : ''}
                      {p.packQuantity ? ` · ${p.packQuantity}/case` : ''}
                    </div>
                    {/* Price Increase Indicator */}
                    {(() => {
                      const curCost = p.costPrice ? parseFloat(p.costPrice) : null;
                      const prevCost = p.previousCostPrice ? parseFloat(p.previousCostPrice) : null;
                      if (!curCost || !prevCost || Math.abs(curCost - prevCost) < 0.001) return null;
                      const diff = curCost - prevCost;
                      const pct = prevCost > 0 ? (diff / prevCost) * 100 : 0;
                      const isInc = diff > 0;
                      return (
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                            isInc 
                              ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800' 
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                          }`}>
                            <span>{isInc ? '▲ Cost Increased' : '▼ Cost Decreased'}:</span>
                            <span className="line-through text-gray-400 font-mono">₹{prevCost.toFixed(2)}</span>
                            <span>➔</span>
                            <span className="font-bold font-mono">₹{curCost.toFixed(2)}</span>
                            <span className="font-bold font-mono">({isInc ? '+' : ''}₹{diff.toFixed(2)}, {isInc ? '+' : ''}{pct.toFixed(1)}%)</span>
                          </span>
                          {p.lastInvoiceNumber && (
                            <span className="text-[10px] text-gray-500 font-mono">
                              Inv #{p.lastInvoiceNumber}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="py-2 px-3">
                    <CategoryBadge categoryName={p.categoryName} productName={p.name} />
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-gray-600 dark:text-gray-400">{p.barcode || '—'}</td>
                  <td className="py-2 px-3 text-right">
                    {p.costPrice ? (
                      <div>
                        <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
                          ₹{parseFloat(p.costPrice).toFixed(2)}
                        </span>
                        {p.costPerCase && (
                          <div className="text-[10px] text-gray-500 font-mono">
                            ₹{parseFloat(p.costPerCase).toFixed(0)}/cs
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono font-bold text-gray-900 dark:text-gray-100">₹{parseFloat(p.mrp).toFixed(2)}</td>
                  <td className="py-2 px-3 text-right">
                    {p.costPrice && p.mrp ? (() => {
                      const cost = parseFloat(p.costPrice);
                      const mrp = parseFloat(p.mrp);
                      const margin = mrp > 0 ? ((mrp - cost) / mrp) * 100 : 0;
                      return (
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-bold ${
                          margin >= 20 ? 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/30' : 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30'
                        }`}>
                          {margin.toFixed(1)}%
                        </span>
                      );
                    })() : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-gray-700 dark:text-gray-300">
                    {stockMap[p.id] !== undefined ? stockMap[p.id] : '—'}
                  </td>
                  {isManager && (
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        className="btn-sec btn-sm px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded border border-gray-300 dark:border-gray-600 text-xs transition-colors"
                        onClick={() => handleOpenMrp(p)}
                      >
                        Edit MRP
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isManager && (
        <details className="card mgr-only bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 rounded shadow p-4">
          <summary className="font-semibold text-sm cursor-pointer select-none">+ Add product</summary>
          <div className="pad pt-4">
            <form className="form-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4" onSubmit={handleCreateProduct}>
              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npCategory">
                Category
                <select
                  id="npCategory"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  required
                  value={npCategory}
                  onChange={(e) => setNpCategory(e.target.value)}
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npName">
                Name
                <input
                  id="npName"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  required
                  maxLength={200}
                  value={npName}
                  onChange={(e) => setNpName(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npBrand">
                Brand
                <input
                  id="npBrand"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  required
                  maxLength={200}
                  value={npBrand}
                  onChange={(e) => setNpBrand(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npVolume">
                Volume (ml)
                <input
                  id="npVolume"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  type="number"
                  min="1"
                  value={npVolume}
                  onChange={(e) => setNpVolume(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npPack">
                Bottles / case
                <input
                  id="npPack"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  type="number"
                  min="1"
                  max="1000"
                  value={npPack}
                  onChange={(e) => setNpPack(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npMrp">
                MRP (₹)
                <input
                  id="npMrp"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm font-mono focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  required
                  inputMode="decimal"
                  value={npMrp}
                  onChange={(e) => setNpMrp(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npCost">
                Cost price (₹)
                <input
                  id="npCost"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm font-mono focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  inputMode="decimal"
                  value={npCost}
                  onChange={(e) => setNpCost(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npBarcode">
                Barcode
                <input
                  id="npBarcode"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm font-mono focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  maxLength={64}
                  value={npBarcode}
                  onChange={(e) => setNpBarcode(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="npSku">
                SKU
                <input
                  id="npSku"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm font-mono focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  maxLength={64}
                  value={npSku}
                  onChange={(e) => setNpSku(e.target.value)}
                />
              </label>

              <div className="col-span-full pt-2">
                <button
                  className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm disabled:opacity-50 transition-colors"
                  type="submit"
                  disabled={creating}
                >
                  {creating ? 'Creating…' : 'Create product'}
                </button>
              </div>
            </form>
          </div>
        </details>
      )}

      {editProduct && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl max-w-md w-full p-6 border border-gray-200 dark:border-gray-700">
            <div className="flex justify-between items-start mb-1">
              <h3 className="text-lg font-bold" id="modalTitle">Update MRP — {editProduct.name}</h3>
              <button
                type="button"
                onClick={() => setEditProduct(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>
            <div className="muted small text-xs text-gray-500 dark:text-gray-400 mb-4">
              Current MRP ₹{parseFloat(editProduct.mrp).toFixed(2)}. The change is recorded in the price audit log under your name.
            </div>
            <form onSubmit={handleSaveMrp} className="flex flex-col gap-4">
              <label className="field flex flex-col gap-1 text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor="newMrpInput">
                New MRP (₹)
                <input
                  id="newMrpInput"
                  className="input p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded font-mono focus:ring-2 focus:ring-primary/20 focus:outline-none"
                  inputMode="decimal"
                  required
                  value={newMrp}
                  onChange={(e) => setNewMrp(e.target.value)}
                />
              </label>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  className="btn-sec px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded border border-gray-300 dark:border-gray-600 text-sm font-medium transition-colors"
                  onClick={() => setEditProduct(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="mrpSaveBtn"
                  className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium disabled:opacity-50 transition-colors"
                  disabled={savingMrp}
                >
                  {savingMrp ? 'Saving…' : 'Save & audit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
