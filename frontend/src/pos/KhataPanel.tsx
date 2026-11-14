import { useCallback, useEffect, useState } from 'react';
import { inr } from '../components/ui';
import { showToast } from '../lib/print';
import { BeerBottleLoader } from '../components/BeerBottleLoader';

export type KhataCustomer = {
  id: string;
  name: string;
  phone: string;
  creditAllowed: boolean;
  isActive: boolean;
  creditLimit: string;
  currentCredit: string;
};

/** Credit (khata) sale: pick or add a customer, see their limit and what this bill does to it. */
export function KhataPanel({ branchId, canSetLimit, total, customer, onSelect }: {
  branchId: string;
  canSetLimit: boolean;
  total: number;
  customer: KhataCustomer | null;
  onSelect: (c: KhataCustomer | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KhataCustomer[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState('5000');
  const [allow, setAllow] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback((q?: string) => {
    if (!branchId) return;
    setLoading(true);
    const search = q?.trim() ? `?search=${encodeURIComponent(q.trim())}&limit=25` : '?limit=25';
    fetch(`/api/v1/customers/${branchId}${search}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
      .then((r) => (r.ok ? r.json() : { customers: [] }))
      .then((d) => setResults(d.customers || []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, [branchId]);

  useEffect(() => {
    if (customer) return;
    const t = setTimeout(() => load(query), query.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, customer, load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    const p = phone.trim();
    if (!/^[6-9]\d{9}$/.test(p)) { showToast('Enter a valid 10-digit mobile number starting with 6–9.', 'error'); return; }
    if (!name.trim()) { showToast('Customer name is required.', 'error'); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), phone: p };
      if (canSetLimit) { if (limit.trim()) body.creditLimit = limit.trim(); body.creditAllowed = allow; }
      const res = await fetch(`/api/v1/customers/${branchId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create customer');
      showToast(`Customer created: ${data.customer.name}`, 'success');
      onSelect(data.customer);
      setAdding(false); setName(''); setPhone(''); setLimit('5000'); setAllow(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create customer', 'error');
    } finally { setSaving(false); }
  };

  return (
    <div id="creditBox" className="space-y-2 text-xs bg-amber-50/50 dark:bg-amber-950/20 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800">
      <div className="flex justify-between items-center">
        <span className="font-semibold text-amber-900 dark:text-amber-200">Khata / customer credit</span>
        {!adding && (
          <button type="button" id="btnQuickAddCust" onClick={() => setAdding(true)} className="text-[11px] font-semibold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer">+ Add customer</button>
        )}
      </div>

      {adding && (
        <form onSubmit={create} className="p-2 bg-white dark:bg-gray-800 rounded border border-purple-200 dark:border-purple-800 space-y-2">
          <div className="flex justify-between items-center border-b pb-1 dark:border-gray-700">
            <span className="font-bold text-xs text-purple-700 dark:text-purple-300">New khata customer</span>
            <button type="button" onClick={() => setAdding(false)} className="text-gray-400 hover:text-gray-600 text-xs cursor-pointer" aria-label="Cancel">✕</button>
          </div>
          <div>
            <label htmlFor="newCustName" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Customer name *</label>
            <input id="newCustName" required placeholder="e.g. Ramesh Reddy" value={name} onChange={(e) => setName(e.target.value)} className="w-full p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600" />
          </div>
          <div>
            <label htmlFor="newCustPhone" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Mobile (10 digits) *</label>
            <input id="newCustPhone" required maxLength={10} inputMode="numeric" placeholder="9876543210" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full p-2 border rounded text-sm font-mono dark:bg-gray-700 dark:border-gray-600" />
          </div>
          {canSetLimit ? (
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div>
                <label htmlFor="newCustLimit" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Credit limit (₹)</label>
                <input id="newCustLimit" type="number" min="0" step="100" placeholder="5000" value={limit} onChange={(e) => setLimit(e.target.value)} className="w-full p-2 border rounded text-sm font-mono dark:bg-gray-700 dark:border-gray-600" />
              </div>
              <label htmlFor="newCustAllow" className="flex items-center gap-1.5 pt-4 text-[11px] font-semibold text-gray-700 dark:text-gray-300 cursor-pointer">
                <input id="newCustAllow" type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} className="rounded text-purple-600" />
                Allow credit
              </label>
            </div>
          ) : (
            <div className="text-[10px] text-gray-500 bg-gray-50 dark:bg-gray-700 p-1.5 rounded">Registered by the cashier. A credit limit needs a manager.</div>
          )}
          <div className="flex justify-end gap-1.5 pt-1">
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 text-xs border rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Cancel</button>
            <button type="submit" id="newCustSubmit" disabled={saving} className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded font-semibold hover:bg-purple-700 disabled:opacity-50 cursor-pointer">{saving ? 'Saving…' : 'Save & select'}</button>
          </div>
        </form>
      )}

      {!customer ? (
        <div className="space-y-1.5">
          <div className="relative">
            <input id="creditSearch" className="w-full p-2 pr-6 border rounded text-sm dark:bg-gray-700 dark:border-gray-600" placeholder="Search name or phone…" value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs cursor-pointer" aria-label="Clear">✕</button>}
          </div>
          {loading ? (
            <BeerBottleLoader inline size="sm" title="Loading khata customers…" />
          ) : results.length > 0 ? (
            <div id="creditResults" className="max-h-40 overflow-y-auto border rounded divide-y dark:border-gray-700 dark:divide-gray-700 bg-white dark:bg-gray-800">
              {results.map((c) => {
                const lim = parseFloat(c.creditLimit || '0');
                const used = parseFloat(c.currentCredit || '0');
                const rem = Math.max(0, lim - used);
                const disabled = !c.creditAllowed || !c.isActive;
                return (
                  <button key={c.id} type="button" className="list-btn w-full p-2.5 text-left flex justify-between items-center hover:bg-amber-50/60 dark:hover:bg-gray-700 cursor-pointer transition-colors" onClick={() => { onSelect(c); setQuery(''); }}>
                    <div className="truncate pr-1"><b className="text-gray-800 dark:text-gray-200">{c.name}</b> <span className="text-[11px] text-gray-500 font-mono">({c.phone})</span></div>
                    <div className="shrink-0 text-right">
                      {disabled ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-700 font-semibold">Disabled</span>
                        : rem <= 0 ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 dark:bg-red-900/40 font-semibold">Limit ₹0</span>
                        : <span className="text-xs font-mono font-semibold text-emerald-600 dark:text-emerald-400">{inr(rem)}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="p-2 text-center text-xs text-gray-500 bg-white dark:bg-gray-800 border rounded">
              No customer found. <button type="button" className="font-bold text-purple-600 hover:underline cursor-pointer" onClick={() => setAdding(true)}>+ Add customer</button>
            </div>
          )}
        </div>
      ) : (
        <div id="creditCustomerCard" className="p-2.5 border rounded bg-white dark:bg-gray-800 space-y-1.5 shadow-xs">
          <div className="flex justify-between items-center border-b pb-1 dark:border-gray-700">
            <div><b className="text-sm text-gray-800 dark:text-gray-100">{customer.name}</b><span className="text-xs text-gray-500 font-mono ml-1.5">({customer.phone})</span></div>
            <button type="button" className="text-xs text-purple-600 dark:text-purple-400 hover:underline font-semibold cursor-pointer" onClick={() => onSelect(null)}>Change</button>
          </div>
          {(() => {
            const lim = parseFloat(customer.creditLimit || '0');
            const used = parseFloat(customer.currentCredit || '0');
            const rem = Math.max(0, lim - used);
            const projected = used + total;
            const exceeds = lim > 0 && projected > lim;
            return (
              <div className="space-y-1">
                <div className="grid grid-cols-3 gap-1 text-[11px] text-center pt-0.5">
                  <div className="bg-gray-50 dark:bg-gray-700/50 p-1 rounded"><span className="text-gray-400 text-[10px] block">Limit</span><span className="font-mono font-semibold">{inr(lim)}</span></div>
                  <div className="bg-gray-50 dark:bg-gray-700/50 p-1 rounded"><span className="text-gray-400 text-[10px] block">Owes now</span><span className="font-mono font-semibold text-amber-600">{inr(used)}</span></div>
                  <div className="bg-gray-50 dark:bg-gray-700/50 p-1 rounded"><span className="text-gray-400 text-[10px] block">Available</span><span id="creditRemaining" className="font-mono font-bold text-emerald-600 dark:text-emerald-400">{inr(rem)}</span></div>
                </div>
                {total > 0 && !exceeds && <div className="text-[11px] text-gray-500 text-center">After this bill they owe <b className="font-mono">{inr(projected)}</b></div>}
                {exceeds && <div className="p-1.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] font-semibold">Exceeds the credit limit by {inr(projected - lim)}</div>}
                {!customer.creditAllowed && <div className="p-1.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] font-semibold">Credit is switched off for this customer.</div>}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
