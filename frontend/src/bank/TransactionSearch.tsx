import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Badge, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import type { Account, TxnType } from './types';

type Txn = {
  id: string; txnDate: string; description: string; amount: string; direction: 'DEBIT' | 'CREDIT';
  category: string; reference: string | null; source: 'BANK_STATEMENT' | 'MANUAL'; reconStatus: 'MATCHED' | 'UNMATCHED'; createdAt: string;
};
type Result = {
  transactions: Txn[];
  totals: { count: number; debit: string; credit: string; net: string };
  byCategory: { category: string; key: string; count: number; debit: string; credit: string }[];
};

const SOURCE_LABEL: Record<Txn['source'], string> = { BANK_STATEMENT: 'Bank statement', MANUAL: 'Manual' };

/**
 * Everything recorded in the books from bank statements, searchable by category or keyword. Pick a category chip (Rent, Wages,
 * Utilities, ...) or type a word; the totals follow the date range, and every category's total sits beside the list.
 */
export function TransactionSearch({ branchId, account, canAddCategories = true }: { branchId: string; account: Account | null; canAddCategories?: boolean }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [types, setTypes] = useState<TxnType[]>([]);

  useEffect(() => {
    if (!account) { setTypes([]); return; }
    void api.get<TxnType[]>(`/bank/accounts/${account.id}/types`)
      .then(setTypes)
      .catch(() => { /* types are optional */ });
  }, [account?.id]);

  const categoryOptions = useMemo(() => {
    const map = new Map<string, { key: string; label: string; count?: number }>();
    for (const c of result?.byCategory ?? []) {
      map.set(c.key, { key: c.key, label: c.category, count: c.count });
    }
    for (const t of types) {
      const key = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!map.has(key)) {
        map.set(key, { key, label: t.name });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [result?.byCategory, types]);

  const run = useCallback(async () => {
    if (!branchId) return;
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (category) params.set('category', category);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (account) params.set('accountId', account.id);
    try { setResult(await api.get<Result>(`/bank/transactions/${branchId}?${params.toString()}`)); }
    catch (err) { showToast(errorMessage(err), 'error'); }
    finally { setLoading(false); }
  }, [branchId, account, q, category, from, to]);

  // A different bank account is a different list: start again from "All"
  useEffect(() => { setCategory(''); setResult(null); setLoading(true); }, [account?.id]);

  // Search as the person types, without a request per keystroke
  useEffect(() => { const t = window.setTimeout(() => void run(), 250); return () => window.clearTimeout(t); }, [run]);

  const addStandard = async () => {
    if (!account) return;
    try {
      const r = await api.post<{ created: string[] }>(`/bank/accounts/${account.id}/types/defaults`, {});
      showToast(r.created.length ? `Added ${r.created.join(', ')}. They now appear when you record a bank line.` : 'The standard categories are already there', 'success');
    } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  const filtering = !!(q || category || from || to);
  const clear = () => { setQ(''); setCategory(''); setFrom(''); setTo(''); };

  return (
    <div id="txnSearch" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input id="txnQuery" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a category or word, e.g. Rent, Wages, electricity"
          className="p-2 border rounded-lg w-full sm:w-80 dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
        <select
          id="txnCategorySelect"
          aria-label="Transaction type filter"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="p-2 border rounded-lg text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white font-medium"
        >
          <option value="">All transaction types</option>
          {categoryOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}{opt.count !== undefined ? ` (${opt.count})` : ''}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-gray-500">From <input id="txnFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="p-1.5 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" /></label>
        <label className="flex items-center gap-1 text-xs text-gray-500">To <input id="txnTo" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="p-1.5 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" /></label>
        {filtering && <button type="button" id="txnClear" onClick={clear} className="text-xs text-purple-700 dark:text-purple-300 font-semibold hover:underline cursor-pointer">Clear</button>}
        {canAddCategories && account && <button type="button" id="txnAddStandard" onClick={() => void addStandard()} className="ml-auto text-xs px-3 py-1.5 rounded-lg border dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">
          + Add standard categories
        </button>}
      </div>

      {/* Every category in this range: one tap narrows the list to it */}
      <div className="flex flex-wrap gap-2" id="txnCategories">
        <button type="button" data-category="" onClick={() => setCategory('')}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer ${category === '' ? 'bg-purple-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>All</button>
        {(result?.byCategory ?? []).map((c) => (
          <button key={c.key} type="button" data-category={c.key} onClick={() => setCategory(category === c.key ? '' : c.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer ${category === c.key ? 'bg-purple-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>
            {c.category} <span className="font-mono opacity-80">{inr(Number(c.debit) + Number(c.credit))}</span>
          </button>
        ))}
      </div>

      {result && (
        <div id="txnTotals" className="flex flex-wrap divide-x divide-gray-100 dark:divide-gray-700 text-xs rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="flex-1 min-w-[7rem] px-3 py-2"><div className="text-gray-500">Transactions</div><div id="txnCount" className="font-mono font-semibold">{result.totals.count}</div></div>
          <div className="flex-1 min-w-[7rem] px-3 py-2"><div className="text-gray-500">Money out (debit)</div><div id="txnDebit" className="font-mono font-semibold text-red-600 dark:text-red-400">{inr(result.totals.debit)}</div></div>
          <div className="flex-1 min-w-[7rem] px-3 py-2"><div className="text-gray-500">Money in (credit)</div><div id="txnCredit" className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{inr(result.totals.credit)}</div></div>
          <div className="flex-1 min-w-[7rem] px-3 py-2"><div className="text-gray-500">Net</div><div id="txnNet" className="font-mono font-semibold">{inr(result.totals.net)}</div></div>
        </div>
      )}

      <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800">
        <table className="min-w-full text-xs" id="txnTable">
          <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300">
            <tr>
              {['Date', 'Description', 'Category', 'Ref no.', 'Debit (out)', 'Credit (in)', 'Source', 'Status', 'Recorded'].map((h) => (
                <th key={h} className={`font-semibold px-3 py-2 whitespace-nowrap ${h.startsWith('Debit') || h.startsWith('Credit') ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">Loading…</td></tr>}
            {!loading && result?.transactions.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">
                {filtering ? 'No transactions match.' : 'Nothing recorded yet. Post a bank statement line to your books and it shows up here.'}
              </td></tr>
            )}
            {(result?.transactions ?? []).map((t) => (
              <tr key={t.id} data-txn={t.id} className="border-t border-gray-100 dark:border-gray-700">
                <td className="px-3 py-2 whitespace-nowrap">{t.txnDate}</td>
                <td className="px-3 py-2 min-w-[14rem] max-w-md whitespace-normal break-words" title={t.description}>{t.description}</td>
                <td className="px-3 py-2"><Badge tone="info">{t.category}</Badge></td>
                <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{t.reference || '—'}</td>
                <td className="px-3 py-2 text-right font-mono text-red-600 dark:text-red-400">{t.direction === 'DEBIT' ? inr(t.amount) : ''}</td>
                <td className="px-3 py-2 text-right font-mono text-emerald-600 dark:text-emerald-400">{t.direction === 'CREDIT' ? inr(t.amount) : ''}</td>
                <td className="px-3 py-2 whitespace-nowrap">{SOURCE_LABEL[t.source]}</td>
                <td className="px-3 py-2"><Badge tone={t.reconStatus === 'MATCHED' ? 'good' : 'warn'}>{t.reconStatus === 'MATCHED' ? 'reconciled' : 'unreconciled'}</Badge></td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{new Date(t.createdAt).toLocaleDateString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
