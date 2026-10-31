import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, showToast } from '../lib/print';
import { Field, Modal, inr } from '../components/ui';

export type MenuKind = 'kitchen' | 'bar';

interface Serving {
  id?: string;
  label: string;
  volumeMl: number | null;
  price: string;
  isActive?: boolean;
}

interface MenuItem {
  id: string;
  name: string;
  brand: string;
  description: string | null;
  mrp: string;
  gstRate: string | null;
  effectiveGstRate: string;
  isAvailable: boolean;          // as this branch sees it
  sharedAvailable?: boolean;     // the business-wide switch
  branchOverride?: boolean;      // this branch has switched it independently
  hsnCode?: string | null;
  volumeMl: number | null;
  categoryName: string | null;
  servings: Serving[];
}

interface HistoryRow {
  at: string;
  oldPrice: string | null;
  newPrice: string;
  by: string | null;
  serving: string | null;
}

interface CatalogProduct {
  id: string;
  name: string;
  menuType: string;
  mrp: string;
  volumeMl?: number | null;
}

interface FormState {
  id?: string;
  name: string;
  categoryName: string;
  price: string;
  gstRate: string;
  description: string;
  hsnCode: string;
  isAvailable: boolean;
  volumeMl: string;
  servings: Serving[];
}

const emptyForm = (kind: MenuKind): FormState => ({
  name: '',
  categoryName: '',
  price: '',
  gstRate: kind === 'kitchen' ? '5' : '18',
  description: '',
  hsnCode: kind === 'kitchen' ? '9963' : '22083020',
  isAvailable: true,
  volumeMl: kind === 'bar' ? '750' : '',
  servings: [],
});


const COPY = {
  kitchen: {
    title: 'Kitchen Menu',
    subtitle: 'Food items sold through table orders and billing. Rates include GST.',
    add: 'Add dish',
    empty: 'No dishes yet. Add your first dish to start taking food orders.',
    categoryHint: 'e.g. Starters, Main Course, Desserts',
  },
  bar: {
    title: 'Bar Menu',
    subtitle: 'Drinks sold by the peg or glass and by the bottle. Each serving has its own fixed rate (incl. GST).',
    add: 'Add drink',
    empty: 'No bar items yet. Add a drink, or adopt a bottle from your catalog.',
    categoryHint: 'e.g. Whisky, Beer, Cocktails, Soft Drinks',
  },
} as const;

export function MenuManager({ kind }: { kind: MenuKind }) {
  const { user } = useAuth();
  const canEdit = user?.role === 'manager' || user?.role === 'owner';
  const branchId = user?.branchId;
  const copy = COPY[kind];

  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{ item: MenuItem; rows: HistoryRow[] } | null>(null);
  const [deleting, setDeleting] = useState<MenuItem | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[] | null>(null);
  const [adoptId, setAdoptId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: MenuItem[] }>(`/menu/${kind}${branchId ? `?branchId=${branchId}` : ''}`);
      setItems(res.items);
    } catch (err) {
      showToast('Could not load menu: ' + errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [kind, branchId]);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.categoryName).filter((c): c is string => !!c))].sort(),
    [items],
  );

  const visible = items.filter((i) => {
    const q = search.trim().toLowerCase();
    return (!category || i.categoryName === category) && (!q || i.name.toLowerCase().includes(q));
  });

  // ── Actions ──────────────────────────────────────────────────────────────

  const openEdit = (item: MenuItem) => {
    setFormError(null);
    setForm({
      id: item.id,
      name: item.name,
      categoryName: item.categoryName ?? '',
      price: item.mrp,
      gstRate: item.gstRate ?? item.effectiveGstRate,
      description: item.description ?? '',
      hsnCode: item.hsnCode ?? '',
      isAvailable: item.sharedAvailable ?? item.isAvailable,
      volumeMl: item.volumeMl ? String(item.volumeMl) : '',
      servings: item.servings.map((s) => ({ id: s.id, label: s.label, volumeMl: s.volumeMl, price: s.price })),
    });
  };

  /** The pill switches the item for the branch being worked in; the edit form holds the business-wide switch. */
  const toggleAvailability = async (item: MenuItem) => {
    try {
      if (branchId) {
        await api.put(`/menu/items/${item.id}/branch-availability`, { branchId, isAvailable: !item.isAvailable });
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, isAvailable: !i.isAvailable, branchOverride: true } : i)));
      } else {
        await api.patch(`/menu/items/${item.id}`, { isAvailable: !item.isAvailable });
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, isAvailable: !i.isAvailable } : i)));
      }
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      const servings = form.servings
        .filter((s) => s.label.trim() && s.price)
        .map((s) => ({ id: s.id, label: s.label.trim(), volumeMl: s.volumeMl, price: s.price }));
      const base = {
        name: form.name.trim(),
        categoryName: form.categoryName.trim(),
        price: form.price,
        gstRate: form.gstRate,
        description: form.description.trim(),
        hsnCode: form.hsnCode.trim(),
        isAvailable: form.isAvailable,
      };
      if (form.id) {
        await api.patch(`/menu/items/${form.id}`, {
          ...base,
          ...(kind === 'bar' ? { volumeMl: form.volumeMl ? Number(form.volumeMl) : null } : {}),
        });
        if (kind === 'bar') await api.put(`/menu/items/${form.id}/servings`, { servings });
      } else {
        await api.post(`/menu/${kind}`, {
          ...base,
          ...(kind === 'bar' ? { volumeMl: form.volumeMl ? Number(form.volumeMl) : undefined, servings } : {}),
        });
      }
      showToast(form.id ? 'Item updated.' : 'Item added.');
      setForm(null);
      load();
    } catch (err) {
      setFormError(friendlyValidation(errorMessage(err)));
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async (item: MenuItem) => {
    try {
      const res = await api.get<{ history: HistoryRow[] }>(`/menu/items/${item.id}/price-history`);
      setHistory({ item, rows: res.history });
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await api.delete(`/menu/items/${deleting.id}`);
      showToast(`"${deleting.name}" removed from the menu.`);
      setDeleting(null);
      load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const openAdopt = async () => {
    try {
      const all = await api.get<CatalogProduct[]>('/products');
      setCatalog(all.filter((p) => p.menuType === 'RETAIL'));
      setAdoptId('');
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const adopt = async () => {
    if (!adoptId) return;
    try {
      await api.patch(`/menu/items/${adoptId}`, { menuType: 'BAR' });
      setCatalog(null);
      showToast('Bottle added to the bar menu. Now add its peg servings.');
      await load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  // ── Serving editor helpers ───────────────────────────────────────────────

  const updateServing = (idx: number, patch: Partial<Serving>) =>
    setForm((f) => f && { ...f, servings: f.servings.map((s, i) => (i === idx ? { ...s, ...patch } : s)) });

  const addServing = (volumeMl: number | null) =>
    setForm((f) => {
      if (!f) return f;
      const label = volumeMl ? `${volumeMl} ml` : 'Full bottle';
      if (f.servings.some((s) => s.label.toLowerCase() === label.toLowerCase())) return f;
      return { ...f, servings: [...f.servings, { label, volumeMl, price: volumeMl ? '' : f.price }] };
    });

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="max-w-6xl mx-auto space-y-5" id={`page-menu-${kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{copy.title}</h1>
          <p className="text-sm text-gray-500 mt-1">{copy.subtitle}</p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            {kind === 'bar' && (
              <button type="button" onClick={openAdopt} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
                Add from catalog
              </button>
            )}
            <button
              type="button"
              id="menuAddBtn"
              onClick={() => { setFormError(null); setForm(emptyForm(kind)); }}
              className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer"
            >
              + {copy.add}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          className="flex-1 min-w-[200px] p-2 border rounded-lg text-sm dark:bg-gray-800 dark:border-gray-600"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="p-2 border rounded-lg text-sm dark:bg-gray-800 dark:border-gray-600"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading menu…</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">{items.length === 0 ? copy.empty : 'No items match.'}</div>
        ) : (
          <table className="w-full text-left text-sm" id="menuTable">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-gray-500 bg-gray-50 dark:bg-gray-900/40 dark:border-gray-700">
                <th className="py-2.5 px-4">Item</th>
                <th className="py-2.5 px-4">{kind === 'bar' ? 'Servings & rates' : 'Rate'}</th>
                <th className="py-2.5 px-4 w-20">GST</th>
                <th className="py-2.5 px-4 w-32">Availability</th>
                {canEdit && <th className="py-2.5 px-4 w-44 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {visible.map((i) => (
                <tr key={i.id} className={`menu-row ${i.isAvailable ? '' : 'opacity-60'}`} data-item-name={i.name}>
                  <td className="py-3 px-4">
                    <div className="font-medium">{i.name}</div>
                    <div className="text-xs text-gray-500">
                      {i.categoryName}
                      {kind === 'bar' && i.volumeMl ? ` · ${i.volumeMl} ml bottle` : ''}
                    </div>
                    {i.description && <div className="text-xs text-gray-400 mt-0.5 max-w-xs truncate">{i.description}</div>}
                  </td>
                  <td className="py-3 px-4">
                    {kind === 'bar' && i.servings.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {i.servings.map((s) => (
                          <span key={s.id} className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-xs">
                            {s.label} <b className="font-mono">{inr(s.price)}</b>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="font-mono font-semibold">{inr(i.mrp)}</span>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono">{Number(i.effectiveGstRate)}%</td>
                  <td className="py-3 px-4">
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => toggleAvailability(i)}
                      className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                        i.isAvailable ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                      } ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                      title={canEdit ? (branchId ? 'Click to switch for this branch only' : 'Click to switch') : undefined}
                    >
                      {i.isAvailable ? 'In stock' : 'Out of stock'}
                    </button>
                    {i.branchOverride && <div className="text-[10px] text-gray-500 mt-0.5">this branch only</div>}
                  </td>
                  {canEdit && (
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button type="button" className="text-xs text-purple-600 hover:underline mr-3 cursor-pointer" onClick={() => openEdit(i)}>Edit</button>
                      <button type="button" className="text-xs text-gray-600 dark:text-gray-300 hover:underline mr-3 cursor-pointer" onClick={() => openHistory(i)}>Rate history</button>
                      <button type="button" className="text-xs text-red-600 hover:underline cursor-pointer" onClick={() => setDeleting(i)}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / edit */}
      {form && (
        <Modal onClose={() => setForm(null)} title={form.id ? 'Edit item' : copy.add}>
          <form onSubmit={save} className="space-y-4">
            {formError && <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg">{formError}</div>}
            <Field label="Name">
              <input id="menuName" className="input-base" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <input id="menuCategory" className="input-base" list="menuCategories" placeholder={copy.categoryHint} value={form.categoryName} onChange={(e) => setForm({ ...form, categoryName: e.target.value })} required />
                <datalist id="menuCategories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="GST %">
                <input id="menuGst" className="input-base font-mono" inputMode="decimal" value={form.gstRate} onChange={(e) => setForm({ ...form, gstRate: e.target.value })} required />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={kind === 'bar' ? 'Full bottle rate (₹)' : 'Rate (₹, incl. GST)'}>
                <input id="menuPrice" className="input-base font-mono" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
              </Field>
              {kind === 'bar' && (
                <Field label="Bottle size (ml)">
                  <input id="menuVolume" className="input-base font-mono" type="number" min="1" value={form.volumeMl} onChange={(e) => setForm({ ...form, volumeMl: e.target.value })} />
                </Field>
              )}
            </div>
            <Field label="HSN / SAC code" hint="Printed on GST invoices.">
              <input id="menuHsn" className="input-base font-mono" value={form.hsnCode} onChange={(e) => setForm({ ...form, hsnCode: e.target.value })} maxLength={10} />
            </Field>
            <Field label="Description (optional)">
              <textarea className="input-base" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>

            {kind === 'bar' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-700 dark:text-gray-300">Servings &amp; fixed rates</span>
                  <div className="flex gap-1.5 text-xs">
                    {[30, 60, 90].map((ml) => (
                      <button key={ml} type="button" className="px-2 py-1 border rounded hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer" onClick={() => addServing(ml)}>+ {ml} ml</button>
                    ))}
                    <button type="button" className="px-2 py-1 border rounded hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer" onClick={() => addServing(null)}>+ Bottle</button>
                    <button type="button" className="px-2 py-1 border rounded hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer" onClick={() => setForm({ ...form, servings: [...form.servings, { label: '', volumeMl: null, price: '' }] })}>+ Custom</button>
                  </div>
                </div>
                {form.servings.length === 0 && <p className="text-xs text-gray-500">No servings yet — the drink is sold only at the bottle rate.</p>}
                {form.servings.map((s, idx) => (
                  <div key={s.id ?? idx} className="grid grid-cols-[1fr_90px_110px_auto] gap-2 items-center serving-row">
                    <input className="input-base" placeholder="Label" value={s.label} onChange={(e) => updateServing(idx, { label: e.target.value })} />
                    <input className="input-base font-mono" type="number" min="1" placeholder="ml" title="Leave empty for a whole bottle" value={s.volumeMl ?? ''} onChange={(e) => updateServing(idx, { volumeMl: e.target.value ? Number(e.target.value) : null })} />
                    <input className="input-base font-mono" inputMode="decimal" placeholder="Rate ₹" value={s.price} onChange={(e) => updateServing(idx, { price: e.target.value })} />
                    <button type="button" className="text-red-600 text-sm px-1 cursor-pointer" aria-label="Remove serving" onClick={() => setForm({ ...form, servings: form.servings.filter((_, i) => i !== idx) })}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.isAvailable} onChange={(e) => setForm({ ...form, isAvailable: e.target.checked })} />
              Available (in stock) at all branches
            </label>

            <div className="flex justify-end gap-3 pt-2 border-t dark:border-gray-700">
              <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setForm(null)}>Cancel</button>
              <button id="menuSaveBtn" type="submit" disabled={saving} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Rate history */}
      {history && (
        <Modal onClose={() => setHistory(null)} title={`Rate history — ${history.item.name}`}>
          {history.rows.length === 0 ? (
            <p className="text-sm text-gray-500">No rate changes recorded.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-gray-500 border-b dark:border-gray-700">
                    <th className="py-2 pr-3">When</th><th className="py-2 pr-3">What</th><th className="py-2 pr-3 text-right">From</th><th className="py-2 pr-3 text-right">To</th><th className="py-2">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {history.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="py-2 pr-3 text-xs text-gray-500 whitespace-nowrap">{new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="py-2 pr-3 text-xs">{r.serving ?? 'Rate'}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-gray-500">{r.oldPrice ? inr(r.oldPrice) : '—'}</td>
                      <td className="py-2 pr-3 text-right font-mono font-semibold">{inr(r.newPrice)}</td>
                      <td className="py-2 text-xs">{r.by ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {/* Delete */}
      {deleting && (
        <Modal onClose={() => setDeleting(null)} title="Remove from menu?">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            "{deleting.name}" will be hidden from the menu, POS and table orders. Past bills keep their record.
          </p>
          <div className="flex justify-end gap-3 pt-4">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setDeleting(null)}>Cancel</button>
            <button id="menuDeleteOk" type="button" className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg cursor-pointer" onClick={confirmDelete}>Remove</button>
          </div>
        </Modal>
      )}

      {/* Adopt a catalog bottle */}
      {catalog && (
        <Modal onClose={() => setCatalog(null)} title="Add a catalog bottle to the bar menu">
          <select className="input-base" value={adoptId} onChange={(e) => setAdoptId(e.target.value)}>
            <option value="">Select a bottle…</option>
            {catalog.map((p) => <option key={p.id} value={p.id}>{p.name} — {inr(p.mrp)}</option>)}
          </select>
          <div className="flex justify-end gap-3 pt-4">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setCatalog(null)}>Cancel</button>
            <button type="button" disabled={!adoptId} className="px-4 py-2 text-sm font-semibold bg-purple-600 disabled:opacity-50 text-white rounded-lg cursor-pointer" onClick={adopt}>Add to bar menu</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────

function friendlyValidation(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const fields = parsed?.details?.fieldErrors as Record<string, string[]> | undefined;
    if (fields) {
      const first = Object.entries(fields).find(([, v]) => v?.length);
      if (first) return `${first[0]}: ${first[1][0]}`;
    }
    return parsed.error || raw;
  } catch {
    return raw;
  }
}

