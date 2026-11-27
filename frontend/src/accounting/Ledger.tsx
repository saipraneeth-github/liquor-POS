import { ACCOUNTING_HELP, ACCOUNTING_SECTIONS, AccountingNavigation, type AccountingTab } from './AccountingNavigation';
import { Link } from 'react-router-dom';
import { Plus, Landmark } from 'lucide-react';
import { ExpenseModal } from './ExpenseModal';
import { canOpenPage } from '../auth/navigation';
import { useT } from '../i18n';
import './accounting.css';
import { useState, useEffect } from 'react';
import { api, authFetch } from '../api/client';
import { useAuth, userCan } from '../auth/AuthProvider';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { BankTransactions } from '../bank/BankTransactions';
import { CashBook } from './CashBook';
import { Expenses } from './Expenses';
import { Suppliers } from './Suppliers';
import { Margin } from './Margin';

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
  const { user, activeBranchId, branches, disabledFeatures } = useAuth();
  const { t } = useT();
  const [tab, setTab] = useState<AccountingTab>('cashbook');
  const [expenseBranch, setExpenseBranch] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);
  const [reportError, setReportError] = useState(false);
  const [loading, setLoading] = useState(false);

  const [tbData, setTbData] = useState<TrialBalanceResponse | null>(null);
  const [plData, setPlData] = useState<ProfitLossResponse | null>(null);
  const [bsData, setBsData] = useState<BalanceSheetResponse | null>(null);
  const [tallyResult, setTallyResult] = useState('');
  const [tallyDownloading, setTallyDownloading] = useState(false);

  const branchId = activeBranchId ?? (user as any)?.branchId ?? '';

  useEffect(() => {
    let live = true;
    setReportError(false);
    setTbData(null); setPlData(null); setBsData(null);
    if (!branchId || !['tb', 'pl', 'bs'].includes(tab)) { setLoading(false); return; }
    setLoading(true);
    const endpoint = tab === 'tb' ? 'trial-balance' : tab === 'pl' ? 'profit-loss' : 'balance-sheet';
    api.get<TrialBalanceResponse | ProfitLossResponse | BalanceSheetResponse>(`/accounting/${endpoint}/${branchId}`)
      .then((data) => {
        if (!live) return;
        if (tab === 'tb') setTbData(data as TrialBalanceResponse);
        else if (tab === 'pl') setPlData(data as ProfitLossResponse);
        else setBsData(data as BalanceSheetResponse);
      }).catch(() => { if (live) setReportError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId, tab, revision]);

  const handleDownloadTally = async () => {
    if (!branchId) return;
    setTallyDownloading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await authFetch(`/api/v1/accounting/tally-export/${branchId}`, {
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
    <div id="page-accounting" className="accounting-workspace space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 dark:border-gray-700 pb-6">
        <div><h1 className="font-display text-3xl font-bold">{t('Accounting')}</h1><p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{branches.find((b) => b.id === branchId)?.name ?? t('Your shop')} · {t('Check daily money, supplier payments and financial reports.')}</p></div>
        <div className="flex flex-wrap gap-3">
          {user && canOpenPage(user, '/bank', disabledFeatures) && <Link to="/bank" className="inline-flex items-center gap-2 min-h-12 rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-semibold"><Landmark size={18} aria-hidden="true" />{t('Match Bank Statement')}</Link>}
          {userCan(user, 'accounting.post') && <button id="accountingRecordExpense" disabled={!branchId} type="button" onClick={() => { setSaved(false); setExpenseBranch(branchId); }} className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-3 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"><Plus size={18} aria-hidden="true" />{t('Record expense')}</button>}
        </div>
      </header>
      {saved && <p role="status" className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 p-3 text-emerald-800 dark:text-emerald-200">{t('Expense recorded')}</p>}
      {expenseBranch !== null && <ExpenseModal initialBranchId={expenseBranch} onClose={() => setExpenseBranch(null)} onSaved={() => { setExpenseBranch(null); setSaved(true); setRevision((r) => r + 1); }} />}
      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <AccountingNavigation tab={tab} onChange={(next) => { setReportError(false); setTab(next); }} />
      <section className="min-w-0 space-y-5" aria-labelledby="accountingSectionTitle" key={branchId + revision}>
      <div><h2 id="accountingSectionTitle" className="font-display text-xl font-bold">{t(ACCOUNTING_SECTIONS.flatMap((s) => [...s.items]).find((i) => i.id === tab)?.label ?? '')}</h2><p className="mt-1 text-sm text-gray-500">{t(ACCOUNTING_HELP[tab])}</p></div>
      {!branchId && <p role="status">{t('Choose a shop')}</p>}
      {reportError && ['tb', 'pl', 'bs'].includes(tab) && !loading && <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm"><p>{t('Could not load this report. Try again.')}</p><button type="button" onClick={() => setRevision((r) => r + 1)} className="mt-2 underline">{t('Try again')}</button></div>}

      {loading && (
        <div className="card pad p-8 bg-white dark:bg-gray-800 rounded shadow">
          <p role="status" className="text-sm">{t('Loading report…')}</p>
        </div>
      )}

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

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border dark:border-gray-700 overflow-x-auto">
            <table className="accounting-stack-table w-full text-left text-sm">
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
                    <td data-label={t('Ledger')} className="p-3 font-medium">{row.name} <span className="text-xs text-gray-400 font-mono">({row.code})</span></td>
                    <td data-label={t('Group')} className="p-3 text-gray-500">{row.group}</td>
                    <td data-label={t('Debit')} className="p-3 text-right font-mono">{parseFloat(row.debit) > 0 ? fmtMoney(row.debit) : '—'}</td>
                    <td data-label={t('Credit')} className="p-3 text-right font-mono">{parseFloat(row.credit) > 0 ? fmtMoney(row.credit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-bold bg-gray-50 dark:bg-gray-700/50 dark:border-gray-700">
                <tr>
                  <td colSpan={2} className="p-3">Total</td>
                  <td className="p-3 text-right font-mono" data-label={t('Debit')} id="tbDebit">{fmtMoney(tbData.totalDebit)}</td>
                  <td className="p-3 text-right font-mono" data-label={t('Credit')} id="tbCredit">{fmtMoney(tbData.totalCredit)}</td>
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
      {tab === 'cashbook' && <CashBook branchId={branchId} />}
      {tab === 'expenses' && <Expenses branchId={branchId} />}
      {tab === 'suppliers' && <Suppliers branchId={branchId} />}
      {tab === 'margin' && <Margin branchId={branchId} />}
      {tab === 'bank' && <BankTransactions branchId={branchId} />}

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

      {/* Beer Bottle Loader for Tally Export */}
      <BeerBottleLoader
        open={tallyDownloading}
        title="Exporting Tally XML…"
        subtitle="Generating ledger XML entries & financial vouchers for Tally import…"
        stage="saving"
      />
      </section>
      </div>
    </div>
  );
}
