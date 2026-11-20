/**
 * PlatformMaster — Super Admin: the master product catalog every business picks from (no prices) and the platform categories.
 * Editing a product's brand, pack, SKU or category tells every business that added it "update available".
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';

interface MasterRow {
  id: string; state: string; categoryName: string; name: string; brand: string; volumeMl: number; packQuantity: number;
  exciseCode: string; sku: string; isActive: boolean; revision: number; businesses: number;
}
interface Catalog { total: number; items: MasterRow[] }
interface Cat { id: string; name: string; taxRate: string; masterProducts: number }

const PAGE = 100;
const box = 'card bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow';
const input = 'p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded text-sm';

export function PlatformMaster() {
  const [cats, setCats] = useState<Cat[]>([]);
  const [data, setData] = useState<Catalog>({ total: 0, items: [] });
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [active, setActive] = useState<'' | '1' | '0'>('');
  const [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<MasterRow | null>(null);
  const [editForm, setEditForm] = useState({ name: '', brand: '', categoryName: '', packQuantity: '', sku: '', isActive: true });
  const [catEdits, setCatEdits] = useState<Record<string, string>>({});
  const [newCat, setNewCat] = useState({ name: '', taxRate: '18' });
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCats = useCallback(async () => { try { setCats(await api.get<Cat[]>('/platform/master/categories')); } catch (e) { setError(errorMessage(e)); } }, []);
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (q.trim()) p.set('q', q.trim());
      if (category) p.set('category', category);
      if (active) p.set('active', active);
      setData(await api.get<Catalog>(`/platform/master/products?${p}`));
      setError(null);
    } catch (e) { setError(errorMessage(e)); }
  }, [q, category, active, offset]);
  useEffect(() => { void loadCats(); }, [loadCats]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { setOffset(0); }, [q, category, active]);

  const openEdit = (r: MasterRow) => {
    setEdit(r);
    setEditForm({ name: r.name, brand: r.brand, categoryName: r.categoryName, packQuantity: String(r.packQuantity), sku: r.sku, isActive: r.isActive });
  };
  const saveEdit = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api.patch(`/platform/master/products/${edit.id}`, { ...editForm, packQuantity: Number(editForm.packQuantity) });
      showToast('Saved. Businesses that added this product will see "update available" if it changed.', 'success');
      setEdit(null);
      await Promise.all([load(), loadCats()]);
    } catch (e) { showToast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  const saveCat = async (c: Cat) => {
    const rate = (catEdits[c.id] ?? c.taxRate).trim();
    try { await api.patch(`/platform/master/categories/${c.id}`, { name: c.name, taxRate: rate }); showToast(`${c.name}: GST ${rate}%`, 'success'); setCatEdits((s) => { const n = { ...s }; delete n[c.id]; return n; }); await loadCats(); }
    catch (e) { showToast(errorMessage(e), 'error'); }
  };
  const addCat = async () => {
    try { await api.post('/platform/master/categories', newCat); setNewCat({ name: '', taxRate: '18' }); await loadCats(); showToast('Category added', 'success'); }
    catch (e) { showToast(errorMessage(e), 'error'); }
  };
  /** CSV / tab lines: category,name,brand,volumeMl,packQuantity,exciseCode,sku[,state] (a header line is ignored) */
  const importPaste = async () => {
    const rows = paste.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, '')))
      .filter((c) => c.length >= 7 && /^\d+$/.test(c[3]))
      .map((c) => ({ categoryName: c[0], name: c[1], brand: c[2], volumeMl: Number(c[3]), packQuantity: Number(c[4]), exciseCode: c[5], sku: c[6], state: c[7] || 'TS' }));
    if (rows.length === 0) { showToast('No valid lines. Columns: category, name, brand, volumeMl, packQuantity, exciseCode, sku, state.', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ added: number; updated: number }>('/platform/master/import', { rows });
      showToast(`${r.added} added, ${r.updated} refreshed`, 'success');
      setPaste('');
      await Promise.all([load(), loadCats()]);
    } catch (e) { showToast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <section className="page active lc" id="page-platform-master">
      <div className="lc-page space-y-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Master Catalog</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            The product list every business picks from. It has no prices. Changing a product's brand, pack, SKU or category tells the businesses that added it "update available".
          </p>
        </div>
        {error && <div className="p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700" role="alert">{error}</div>}

        <details className={`${box} p-4`} open>
          <summary className="font-semibold text-sm cursor-pointer select-none">Categories and GST ({cats.length})</summary>
          <div className="pt-3 space-y-2">
            <p className="text-xs text-gray-500">GST here is the rate bills use for every product of the category (a business can override it per product).</p>
            <div className="flex flex-wrap gap-2">
              {cats.map((c) => (
                <div key={c.id} className="flex items-center gap-2 border rounded px-2 py-1 text-sm">
                  <b>{c.name}</b><span className="text-xs text-gray-500">{c.masterProducts} products</span>
                  <input aria-label={`GST % of ${c.name}`} className={`${input} w-16 text-right`} value={catEdits[c.id] ?? c.taxRate} onChange={(e) => setCatEdits((s) => ({ ...s, [c.id]: e.target.value }))} />%
                  {catEdits[c.id] !== undefined && catEdits[c.id] !== c.taxRate && <button type="button" className="text-xs font-semibold text-purple-600 cursor-pointer" onClick={() => void saveCat(c)}>Save</button>}
                </div>
              ))}
              <div className="flex items-center gap-2 border border-dashed rounded px-2 py-1 text-sm">
                <input aria-label="New category name" placeholder="New category" className={`${input} w-36`} value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
                <input aria-label="New category GST %" className={`${input} w-16 text-right`} value={newCat.taxRate} onChange={(e) => setNewCat({ ...newCat, taxRate: e.target.value })} />%
                <button type="button" disabled={newCat.name.trim().length < 2} className="text-xs font-semibold text-purple-600 disabled:opacity-40 cursor-pointer" onClick={() => void addCat()}>Add</button>
              </div>
            </div>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-2">
          <input id="masterAdminSearch" type="search" className={`${input} w-72`} placeholder="Search name, brand, excise code, SKU" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Category" className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>{cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <select aria-label="Status" className={input} value={active} onChange={(e) => setActive(e.target.value as '' | '1' | '0')}>
            <option value="">Active and discontinued</option><option value="1">Active</option><option value="0">Discontinued</option>
          </select>
          <span className="text-xs text-gray-500 ml-auto">{data.total} products</span>
        </div>

        <div className={`${box} overflow-x-auto`}>
          <table className="table w-full text-left">
            <thead><tr className="border-b text-xs text-gray-500 bg-gray-50 dark:bg-gray-900/50">
              <th className="py-2 px-3">Product</th><th className="py-2 px-3">Category</th><th className="py-2 px-3 text-right">Size</th><th className="py-2 px-3 text-right">Pack</th>
              <th className="py-2 px-3">Excise</th><th className="py-2 px-3">SKU</th><th className="py-2 px-3 text-right">Businesses</th><th className="py-2 px-3">Status</th><th className="py-2 px-3" />
            </tr></thead>
            <tbody>
              {data.items.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-sm text-gray-500">No products. Import some below.</td></tr>}
              {data.items.map((r) => (
                <tr key={r.id} className="border-b text-sm text-gray-900 dark:text-gray-100">
                  <td className="py-2 px-3"><b>{r.name}</b><div className="text-xs text-gray-500">{r.brand} · {r.state} · rev {r.revision}</div></td>
                  <td className="py-2 px-3">{r.categoryName}</td>
                  <td className="py-2 px-3 text-right font-mono">{r.volumeMl} ml</td>
                  <td className="py-2 px-3 text-right font-mono">{r.packQuantity}</td>
                  <td className="py-2 px-3 font-mono text-xs">{r.exciseCode}</td>
                  <td className="py-2 px-3 font-mono text-xs">{r.sku}</td>
                  <td className="py-2 px-3 text-right">{r.businesses}</td>
                  <td className="py-2 px-3">{r.isActive ? <span className="text-xs font-semibold text-emerald-700">Active</span> : <span className="text-xs font-semibold text-gray-500">Discontinued</span>}</td>
                  <td className="py-2 px-3 text-right"><button type="button" className="text-xs text-purple-600 hover:underline cursor-pointer" onClick={() => openEdit(r)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.total > PAGE && (
          <div className="flex items-center justify-between text-sm">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="px-3 py-1.5 rounded border disabled:opacity-40 cursor-pointer">Previous</button>
            <span className="text-gray-500">{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
            <button type="button" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} className="px-3 py-1.5 rounded border disabled:opacity-40 cursor-pointer">Next</button>
          </div>
        )}

        <details className={`${box} p-4`}>
          <summary className="font-semibold text-sm cursor-pointer select-none">Add or refresh products (paste CSV)</summary>
          <div className="pt-3 space-y-2">
            <p className="text-xs text-gray-500">One product per line: <code>category, name, brand, volumeMl, packQuantity, exciseCode, sku, state</code> (state defaults to TS). A product with the same state, excise code and size is refreshed; missing categories are created at 18% GST.</p>
            <textarea id="masterPaste" rows={6} className={`${input} w-full font-mono text-xs`} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Whisky,Royal Stag 750ml,Royal Stag,750,12,5028,TS-5028-750,TS" />
            <div className="flex items-center gap-3">
              <input type="file" accept=".csv,.txt" aria-label="Upload a CSV" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPaste(await f.text()); }} />
              <button type="button" id="masterImport" disabled={busy || !paste.trim()} onClick={() => void importPaste()} className="px-3 py-1.5 rounded bg-purple-600 text-white text-sm font-semibold disabled:opacity-40 cursor-pointer">Import</button>
            </div>
          </div>
        </details>
      </div>

      {edit && createPortal(
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Edit master product">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg p-5 space-y-3">
            <h3 className="font-bold text-lg">{edit.name}</h3>
            <p className="text-xs text-gray-500">Size ({edit.volumeMl} ml) and excise code ({edit.exciseCode}) identify the product and cannot be changed. {edit.businesses > 0 && `${edit.businesses} business(es) have added it.`}</p>
            <label className="block text-xs font-medium">Name<input className={`${input} w-full mt-1`} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium">Brand<input className={`${input} w-full mt-1`} value={editForm.brand} onChange={(e) => setEditForm({ ...editForm, brand: e.target.value })} /></label>
              <label className="block text-xs font-medium">Category
                <select className={`${input} w-full mt-1`} value={editForm.categoryName} onChange={(e) => setEditForm({ ...editForm, categoryName: e.target.value })}>
                  {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium">Pack (bottles/case)<input className={`${input} w-full mt-1`} inputMode="numeric" value={editForm.packQuantity} onChange={(e) => setEditForm({ ...editForm, packQuantity: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="block text-xs font-medium">SKU<input className={`${input} w-full mt-1 font-mono`} value={editForm.sku} onChange={(e) => setEditForm({ ...editForm, sku: e.target.value })} /></label>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!editForm.isActive} onChange={(e) => setEditForm({ ...editForm, isActive: !e.target.checked })} /> Discontinued (hidden from "Add from master catalog"; businesses keep what they added)</label>
            <div className="flex justify-end gap-3 pt-1">
              <button type="button" className="px-4 py-2 text-sm border rounded cursor-pointer" onClick={() => setEdit(null)}>Cancel</button>
              <button type="button" disabled={busy || !editForm.name.trim() || !editForm.packQuantity} className="px-4 py-2 text-sm font-semibold bg-purple-600 text-white rounded disabled:opacity-40 cursor-pointer" onClick={() => void saveEdit()}>Save</button>
            </div>
          </div>
        </div>, document.body)}
    </section>
  );
}
