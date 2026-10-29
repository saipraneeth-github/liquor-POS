import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

type TrialBalanceRow = {
  name: string;
  code: string;
  group: string;
  debit: string;
  credit: string;
};

type TrialBalanceResponse = {
  isBalanced: boolean;
  totalDebit: string;
  totalCredit: string;
  difference: string;
  rows: TrialBalanceRow[];
};

type ProfitLossResponse = {
  totalIncome: string;
  totalExpense: string;
  netProfit: string;
  income: { name: string; amount: string }[];
  expenses: { name: string; amount: string }[];
};

type BalanceSheetResponse = {
  isBalanced: boolean;
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  retainedEarnings: string;
  difference: string;
  assets: { name: string; amount: string }[];
  liabilities: { name: string; amount: string }[];
  equity: { name: string; amount: string }[];
};

function fmtMoney(amount: string | number | undefined): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : (amount ?? 0);
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function Ledger() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'tb' | 'pl' | 'bs' | 'tally'>('tb');
  const [loading, setLoading] = useState(false);

  const [tbData, setTbData] = useState<TrialBalanceResponse | null>(null);
  const [plData, setPlData] = useState<ProfitLossResponse | null>(null);
  const [bsData, setBsData] = useState<BalanceSheetResponse | null>(null);
  const [tallyResult, setTallyResult] = useState('');
  const [tallyDownloading, setTallyDownloading] = useState(false);

  const branchId = (user as any)?.branchId ?? '';

  const loadTb = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const res = await api.get<TrialBalanceResponse>(`/accounting/trial-balance/${branchId}`);
      setTbData(res);
    } catch {
      setTbData(null);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  const loadPl = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const res = await api.get<ProfitLossResponse>(`/accounting/profit-loss/${branchId}`);
      setPlData(res);
    } catch {
      setPlData(null);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  const loadBs = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const res = await api.get<BalanceSheetResponse>(`/accounting/balance-sheet/${branchId}`);
      setBsData(res);
    } catch {
      setBsData(null);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    if (tab === 'tb') loadTb();
    else if (tab === 'pl') loadPl();
    else if (tab === 'bs') loadBs();
  }, [tab, loadTb, loadPl, loadBs]);

  const handleDownloadTally = async () => {
    if (!branchId) return;
    setTallyDownloading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/v1/accounting/tally-export/${branchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const filename = 'tally-export.xml';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setTallyResult(`Downloaded ${filename}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Export failed';
      setTallyResult(`Error: ${msg}`);
    } finally {
      setTallyDownloading(false);
    }
  };

  return (
    <div id="page-accounting" className="space-y-4">
      <div className="flex gap-4 border-b dark:border-gray-700 pb-2">
        <button
          id="acctab-tb"
          type="button"
          aria-selected={tab === 'tb'}
          onClick={() => setTab('tb')}
          className={`pb-2 px-3 text-sm font-medium border-b-2 transition ${
            tab === 'tb'
              ? 'border-purple-600 text-purple-600 dark:text-purple-400 font-bold'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Trial Balance
        </button>
        <button
          id="acctab-pl"
          type="button"
          aria-selected={tab === 'pl'}
          onClick={() => setTab('pl')}
          className={`pb-2 px-3 text-sm font-medium border-b-2 transition ${
            tab === 'pl'
              ? 'border-purple-600 text-purple-600 dark:text-purple-400 font-bold'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Profit &amp; Loss
        </button>
        <button
          id="acctab-bs"
          type="button"
          aria-selected={tab === 'bs'}
          onClick={() => setTab('bs')}
          className={`pb-2 px-3 text-sm font-medium border-b-2 transition ${
            tab === 'bs'
              ? 'border-purple-600 text-purple-600 dark:text-purple-400 font-bold'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Balance Sheet
        </button>
        <button
          id="acctab-tally"
          type="button"
          aria-selected={tab === 'tally'}
          onClick={() => setTab('tally')}
          className={`pb-2 px-3 text-sm font-medium border-b-2 transition ${
            tab === 'tally'
              ? 'border-purple-600 text-purple-600 dark:text-purple-400 font-bold'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Tally Export
        </button>
      </div>

      {loading && <div className="p-8 text-center text-gray-500">Loading accounting report...</div>}

      {/* Trial Balance Tab */}
      {!loading && tab === 'tb' && tbData && (
        <div className="space-y-4">
          <div
            id="tbStatus"
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold inline-block ${
              tbData.isBalanced
                ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
            }`}
          >
            {tbData.isBalanced ? 'Balanced ✓' : `Not balanced — difference ${fmtMoney(tbData.difference)}`}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border dark:border-gray-700 overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 border-b dark:border-gray-700">
                <tr>
                  <th className="p-3">Ledger</th>
                  <th className="p-3">Group</th>
                  <th className="p-3 text-right">Debit</th>
                  <th className="p-3 text-right">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {(tbData.rows || []).map((row, idx) => (
                  <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="p-3 font-medium">{row.name} <span className="text-xs text-gray-400 font-mono">({row.code})</span></td>
                    <td className="p-3 text-gray-500">{row.group}</td>
                    <td className="p-3 text-right font-mono">{parseFloat(row.debit) > 0 ? fmtMoney(row.debit) : '—'}</td>
                    <td className="p-3 text-right font-mono">{parseFloat(row.credit) > 0 ? fmtMoney(row.credit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-bold bg-gray-50 dark:bg-gray-700/50 dark:border-gray-700">
                <tr>
                  <td colSpan={2} className="p-3">Total</td>
                  <td className="p-3 text-right font-mono" id="tbDebit">{fmtMoney(tbData.totalDebit)}</td>
                  <td className="p-3 text-right font-mono" id="tbCredit">{fmtMoney(tbData.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Profit & Loss Tab */}
      {!loading && tab === 'pl' && plData && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Income */}
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 space-y-3">
              <h3 className="font-bold text-base text-green-600">Income</h3>
              <div className="divide-y dark:divide-gray-700 text-sm">
                {(plData.income || []).map((i, idx) => (
                  <div key={idx} className="py-2 flex justify-between">
                    <span>{i.name}</span>
                    <span className="font-mono">{fmtMoney(i.amount)}</span>
                  </div>
                ))}
                <div className="pt-2 flex justify-between font-bold">
                  <span>Total Income</span>
                  <span className="font-mono">{fmtMoney(plData.totalIncome)}</span>
                </div>
              </div>
            </div>

            {/* Expenses */}
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 space-y-3">
              <h3 className="font-bold text-base text-red-600">Expenses</h3>
              <div className="divide-y dark:divide-gray-700 text-sm">
                {(plData.expenses || []).map((e, idx) => (
                  <div key={idx} className="py-2 flex justify-between">
                    <span>{e.name}</span>
                    <span className="font-mono">{fmtMoney(e.amount)}</span>
                  </div>
                ))}
                <div className="pt-2 flex justify-between font-bold">
                  <span>Total Expenses</span>
                  <span className="font-mono">{fmtMoney(plData.totalExpense)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 flex justify-between items-center">
            <span className="font-bold text-base">Net Profit / (Loss)</span>
            <span id="plNet" className="font-mono text-xl font-bold text-purple-600 dark:text-purple-400">
              {fmtMoney(plData.netProfit)}
            </span>
          </div>
        </div>
      )}

      {/* Balance Sheet Tab */}
      {!loading && tab === 'bs' && bsData && (
        <div className="space-y-4">
          <div
            id="bsStatus"
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold inline-block ${
              bsData.isBalanced
                ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
            }`}
          >
            {bsData.isBalanced ? 'Balanced ✓' : `Difference ${fmtMoney(bsData.difference)}`}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Assets */}
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 space-y-3">
              <h3 className="font-bold text-base">Assets</h3>
              <div className="divide-y dark:divide-gray-700 text-sm">
                {(bsData.assets || []).map((a, idx) => (
                  <div key={idx} className="py-2 flex justify-between">
                    <span>{a.name}</span>
                    <span className="font-mono">{fmtMoney(a.amount)}</span>
                  </div>
                ))}
                <div className="pt-2 flex justify-between font-bold border-t">
                  <span>Total Assets</span>
                  <span className="font-mono">{fmtMoney(bsData.totalAssets)}</span>
                </div>
              </div>
            </div>

            {/* Liabilities & Equity */}
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 space-y-3">
              <h3 className="font-bold text-base">Liabilities &amp; Equity</h3>
              <div className="divide-y dark:divide-gray-700 text-sm">
                {(bsData.liabilities || []).map((l, idx) => (
                  <div key={idx} className="py-2 flex justify-between">
                    <span>{l.name}</span>
                    <span className="font-mono">{fmtMoney(l.amount)}</span>
                  </div>
                ))}
                {(bsData.equity || []).map((e, idx) => (
                  <div key={idx} className="py-2 flex justify-between">
                    <span>{e.name}</span>
                    <span className="font-mono">{fmtMoney(e.amount)}</span>
                  </div>
                ))}
                <div className="py-2 flex justify-between">
                  <span>Retained Earnings</span>
                  <span className="font-mono">{fmtMoney(bsData.retainedEarnings)}</span>
                </div>
                <div className="pt-2 flex justify-between font-bold border-t">
                  <span>Total</span>
                  <span className="font-mono">{fmtMoney(bsData.totalLiabilitiesAndEquity)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tally Export Tab */}
      {tab === 'tally' && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-sm border dark:border-gray-700 space-y-4 max-w-md">
          <h3 className="font-bold text-base">Tally XML Voucher Export</h3>
          <p className="text-sm text-gray-500">
            Export all approved journal vouchers and invoices in Tally-compliant XML format for seamless accounting sync.
          </p>
          <button
            id="tallyDownloadBtn"
            type="button"
            disabled={tallyDownloading}
            onClick={handleDownloadTally}
            className="px-4 py-2 bg-purple-600 text-white rounded font-medium hover:bg-purple-700 disabled:opacity-50 text-sm"
          >
            {tallyDownloading ? 'Exporting...' : 'Download Tally XML'}
          </button>
          {tallyResult && (
            <div id="tallyResult" className="text-sm font-semibold text-green-600 dark:text-green-400">
              {tallyResult}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
