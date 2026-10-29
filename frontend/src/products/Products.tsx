import { useState, useEffect } from 'react';
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
      const [prodRes, stockRes] = await Promise.all([
        api.get<{ products: Product[]; categories?: Category[] }>('/products'),
        branchId ? api.get<any[]>('/inventory/stock/' + branchId).catch(() => []) : Promise.resolve([]),
      ]);
      setProducts(prodRes.products);
      if (prodRes.categories) {
        setCategories(prodRes.categories);
        if (prodRes.categories.length && !npCategory) {
          setNpCategory(prodRes.categories[0].id);
        }
      }

      const sm: Record<string, number> = {};
      for (const s of stockRes) {
        sm[s.productId] = s.quantity;
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
  const filtered = products.filter(
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
          <h2 className="h1 text-xl font-bold" id="prodTitle">🍷 Product Catalog</h2>
          <div className="muted small text-xs text-gray-500">
            MRP is set here (manager+) and every change is audited. Prices cannot be changed at the counter.
          </div>
        </div>
      </div>

      <div className="row mb-4">
        <label htmlFor="prodSearch" className="sr-only">Search products</label>
        <input
          id="prodSearch"
          className="input p-2 border rounded text-sm w-full max-w-xs"
          style={{ maxWidth: '320px' }}
          placeholder="Search name, brand or barcode"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card table-wrap bg-white rounded shadow overflow-x-auto mb-6" id="prodTable">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading products…</div>
        ) : filtered.length === 0 ? (
          <div className="state p-8 text-center text-gray-500">
            {products.length ? 'No products match.' : 'No products yet.'}
          </div>
        ) : (
          <table className="table w-full text-left">
            <thead>
              <tr className="border-b text-xs text-gray-500 bg-gray-50">
                <th className="py-2 px-3">Product</th>
                <th className="py-2 px-3">Category</th>
                <th className="py-2 px-3">Barcode</th>
                <th className="py-2 px-3 text-right">MRP</th>
                <th className="py-2 px-3 text-right">Stock</th>
                {isManager && <th className="py-2 px-3"></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="border-b hover:bg-gray-50 text-sm">
                  <td className="py-2 px-3">
                    <b>{p.name}</b>
                    <div className="muted small text-xs text-gray-500">
                      {p.brand || ''}
                      {p.volumeMl ? ` · ${p.volumeMl}ml` : ''}
                      {p.packQuantity ? ` · ${p.packQuantity}/case` : ''}
                    </div>
                  </td>
                  <td className="py-2 px-3">
                    <span className="tag px-2 py-0.5 bg-gray-100 rounded text-xs">
                      {p.categoryName || '—'}
                    </span>
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-gray-600">{p.barcode || '—'}</td>
                  <td className="py-2 px-3 text-right font-mono font-bold">₹{parseFloat(p.mrp).toFixed(2)}</td>
                  <td className="py-2 px-3 text-right font-mono">
                    {stockMap[p.id] !== undefined ? stockMap[p.id] : '—'}
                  </td>
                  {isManager && (
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        className="btn-sec btn-sm px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-xs"
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
        <details className="card mgr-only bg-white rounded shadow p-4">
          <summary className="font-semibold text-sm cursor-pointer">+ Add product</summary>
          <div className="pad pt-4">
            <form className="form-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4" onSubmit={handleCreateProduct}>
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npCategory">
                Category
                <select
                  id="npCategory"
                  className="input p-2 border rounded text-sm"
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

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npName">
                Name
                <input
                  id="npName"
                  className="input p-2 border rounded text-sm"
                  required
                  maxLength={200}
                  value={npName}
                  onChange={(e) => setNpName(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npBrand">
                Brand
                <input
                  id="npBrand"
                  className="input p-2 border rounded text-sm"
                  required
                  maxLength={200}
                  value={npBrand}
                  onChange={(e) => setNpBrand(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npVolume">
                Volume (ml)
                <input
                  id="npVolume"
                  className="input p-2 border rounded text-sm"
                  type="number"
                  min="1"
                  value={npVolume}
                  onChange={(e) => setNpVolume(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npPack">
                Bottles / case
                <input
                  id="npPack"
                  className="input p-2 border rounded text-sm"
                  type="number"
                  min="1"
                  max="1000"
                  value={npPack}
                  onChange={(e) => setNpPack(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npMrp">
                MRP (₹)
                <input
                  id="npMrp"
                  className="input p-2 border rounded text-sm font-mono"
                  required
                  inputMode="decimal"
                  value={npMrp}
                  onChange={(e) => setNpMrp(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npCost">
                Cost price (₹)
                <input
                  id="npCost"
                  className="input p-2 border rounded text-sm font-mono"
                  inputMode="decimal"
                  value={npCost}
                  onChange={(e) => setNpCost(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npBarcode">
                Barcode
                <input
                  id="npBarcode"
                  className="input p-2 border rounded text-sm font-mono"
                  maxLength={64}
                  value={npBarcode}
                  onChange={(e) => setNpBarcode(e.target.value)}
                />
              </label>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="npSku">
                SKU
                <input
                  id="npSku"
                  className="input p-2 border rounded text-sm font-mono"
                  maxLength={64}
                  value={npSku}
                  onChange={(e) => setNpSku(e.target.value)}
                />
              </label>

              <div className="col-span-full pt-2">
                <button
                  className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm disabled:opacity-50"
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
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-1" id="modalTitle">Update MRP — {editProduct.name}</h3>
            <div className="muted small text-xs text-gray-500 mb-4">
              Current MRP ₹{parseFloat(editProduct.mrp).toFixed(2)}. The change is recorded in the price audit log under your name.
            </div>
            <form onSubmit={handleSaveMrp} className="flex flex-col gap-4">
              <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="newMrpInput">
                New MRP (₹)
                <input
                  id="newMrpInput"
                  className="input p-2 border rounded font-mono"
                  inputMode="decimal"
                  required
                  value={newMrp}
                  onChange={(e) => setNewMrp(e.target.value)}
                />
              </label>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  className="btn-sec px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-sm font-medium"
                  onClick={() => setEditProduct(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="mrpSaveBtn"
                  className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium disabled:opacity-50"
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

