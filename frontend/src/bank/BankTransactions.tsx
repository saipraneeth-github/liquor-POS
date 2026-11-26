import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';
import { TransactionSearch } from './TransactionSearch';
import type { Account } from './types';
import { useAuth, userCan } from '../auth/AuthProvider';
import { businessDate } from '../lib/business-day';

type Ledger = { id: string; code: string; name: string };

/**
 * Accounting view of everything recorded from bank statements: all of the branch's bank accounts together, or one
 * account at a time. Same search, totals and category chips as the Match Bank Statement screen.
 */
export function BankTransactions({ branchId }: { branchId: string }) {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [accountId, setAccountId] = useState('');   // '' = every account
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [manual, setManual] = useState({ txnDate: businessDate(), description: '', amount: '', direction: 'DEBIT', ledgerId: '', reference: '' });

  useEffect(() => {
    if (!branchId) return;
    api.get<Account[]>(`/bank/accounts?branchId=${branchId}`)
      .then((rows) => { setAccounts(rows); setAccountId((cur) => (rows.some((r) => r.id === cur) ? cur : '')); })
      .catch((err) => showToast(errorMessage(err), 'error'));
    api.get<{ ledgers: Ledger[] }>(`/accounting/ledgers/${branchId}`)
      .then((result) => setLedgers(result.ledgers.filter((ledger) => ledger.code !== 'BANK')))
      .catch((err) => showToast(errorMessage(err), 'error'));
  }, [branchId]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const record = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!account || saving) return;
    setSaving(true);
    try {
      await api.post(`/bank/transactions/${branchId}/manual`, { ...manual, accountId: account.id });
      setManual({ ...manual, description: '', amount: '', reference: '' });
      setRevision((value) => value + 1);
      showToast('Manual bank entry recorded in the books', 'success');
    } catch (error) { showToast(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div id="bankTransactionsTab" className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs">
          <span className="font-semibold text-gray-700 dark:text-gray-300">Bank account</span>
          <select id="acctBankAccount" value={accountId} onChange={(e) => setAccountId(e.target.value)}
            className="mt-1 p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
            <option value="">All bank accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.accountLast4 ? ` ••${a.accountLast4}` : ''}</option>)}
          </select>
        </label>
        <p className="text-xs text-gray-500 pb-2">Bank statement and manual book entries. Match manual entries when the statement arrives.</p>
      </div>
      {account && account.scope === 'BRANCH' && userCan(user, 'accounting.post') && (
        <form onSubmit={(event) => void record(event)} className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 sm:grid-cols-2 lg:grid-cols-3">
          <h3 className="sm:col-span-2 lg:col-span-3 font-semibold">Record bank entry by hand</h3>
          <label className="text-sm">Date<input type="date" required className="input-base mt-1" value={manual.txnDate} onChange={(event) => setManual({ ...manual, txnDate: event.target.value })} /></label>
          <label className="text-sm">Money movement<select className="input-base mt-1" value={manual.direction} onChange={(event) => setManual({ ...manual, direction: event.target.value })}><option value="DEBIT">Money out</option><option value="CREDIT">Money in</option></select></label>
          <label className="text-sm">Amount ₹<input className="input-base mt-1" required inputMode="decimal" pattern="\d{1,10}(\.\d{1,2})?" value={manual.amount} onChange={(event) => setManual({ ...manual, amount: event.target.value })} /></label>
          <label className="text-sm">Description<input className="input-base mt-1" required minLength={3} maxLength={500} value={manual.description} onChange={(event) => setManual({ ...manual, description: event.target.value })} /></label>
          <label className="text-sm">Other ledger<select className="input-base mt-1" required value={manual.ledgerId} onChange={(event) => setManual({ ...manual, ledgerId: event.target.value })}><option value="">Choose ledger</option>{ledgers.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.name}</option>)}</select></label>
          <label className="text-sm">Reference<input className="input-base mt-1" maxLength={100} value={manual.reference} onChange={(event) => setManual({ ...manual, reference: event.target.value })} /></label>
          <button type="submit" disabled={saving} className="rounded-lg bg-purple-700 px-4 py-2 text-white disabled:opacity-50 sm:col-span-2 lg:col-span-3">Record manual entry</button>
        </form>
      )}
      <TransactionSearch key={`${accountId || 'all'}-${revision}`} branchId={branchId} account={account} />
    </div>
  );
}
