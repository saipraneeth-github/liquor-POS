import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';
import { TransactionSearch } from './TransactionSearch';
import type { Account } from './types';

/**
 * Accounting view of everything recorded from bank statements: all of the branch's bank accounts together, or one
 * account at a time. Same search, totals and category chips as the Match Bank Statement screen.
 */
export function BankTransactions({ branchId }: { branchId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');   // '' = every account

  useEffect(() => {
    if (!branchId) return;
    api.get<Account[]>(`/bank/accounts?branchId=${branchId}`)
      .then((rows) => { setAccounts(rows); setAccountId((cur) => (rows.some((r) => r.id === cur) ? cur : '')); })
      .catch((err) => showToast(errorMessage(err), 'error'));
  }, [branchId]);

  const account = accounts.find((a) => a.id === accountId) ?? null;

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
        <p className="text-xs text-gray-500 pb-2">Entries posted to your books from uploaded bank statements.</p>
      </div>
      <TransactionSearch key={accountId || 'all'} branchId={branchId} account={account} />
    </div>
  );
}
