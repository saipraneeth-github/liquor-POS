import { useCallback, useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Field, Modal, inr, ProtectedButton } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { IgnoreRules } from './IgnoreRules';
import { ReconcileStatement } from './ReconcileStatement';
import { TransactionSearch } from './TransactionSearch';
import { UploadStatement } from './UploadStatement';
import type { Account, Scope, StatementRow } from './types';

type View = { name: 'home' } | { name: 'upload' } | { name: 'reconcile'; statementId: string };

export function BankReconciliation() {
  const { user, activeBranchId } = useAuth();
  const branchId = activeBranchId ?? user?.branchId ?? '';
  const isOwner = user?.role === 'owner';

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [view, setView] = useState<View>({ name: 'home' });
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [homeTab, setHomeTab] = useState<'statements' | 'transactions'>('statements');

  const account = accounts.find((a) => a.id === accountId) ?? null;

  const loadAccounts = useCallback(async (select?: string) => {
    try {
      const rows = await api.get<Account[]>(`/bank/accounts${branchId ? `?branchId=${branchId}` : ''}`);
      setAccounts(rows);
      setAccountId((cur) => select ?? (rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? '')));
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  const loadStatements = useCallback(async () => {
    if (!accountId) { setStatements([]); return; }
    try { setStatements(await api.get<StatementRow[]>(`/bank/accounts/${accountId}/statements`)); }
    catch (err) { showToast(errorMessage(err), 'error'); }
  }, [accountId]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => { void loadStatements(); }, [loadStatements]);

  const deleteStatement = async (s: StatementRow) => {
    try { await api.delete(`/bank/statements/${s.id}`); showToast('Statement deleted', 'success'); await loadStatements(); }
    catch (err) { showToast(errorMessage(err), 'error'); }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="space-y-5 w-full">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Match Bank Statement</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Upload your bank statement and tick it off against your books, entry by entry. Works with any bank.</p>
        </div>
        <div className="flex items-end gap-2">
          {accounts.length > 0 && (
            <label className="block text-xs">
              <span className="font-semibold text-gray-700 dark:text-gray-300">Bank account</span>
              <select id="bankAccountSelect" value={accountId} onChange={(e) => { setAccountId(e.target.value); setView({ name: 'home' }); }}
                className="mt-1 p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.accountLast4 ? ` ••${a.accountLast4}` : ''}{a.scope === 'SYNDICATE' ? ' (all outlets)' : ''}</option>)}
              </select>
            </label>
          )}
          <button type="button" id="bankAddAccount" onClick={() => setAdding(true)} className="px-3 py-2 text-sm rounded-lg border dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">+ Add account</button>
        </div>
      </div>

      {accounts.length === 0 && (
        <div className="p-8 text-center bg-white dark:bg-gray-800 rounded-xl border border-dashed border-gray-300 dark:border-gray-600">
          <Landmark size={36} className="mx-auto mb-2 text-gray-400" aria-hidden="true" />
          <h3 className="font-bold text-gray-900 dark:text-white">Add your bank account to begin</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-md mx-auto">Give it a name you will recognise. We only keep the last 4 digits of the account number, never the full number.</p>
          <button type="button" id="bankAddFirst" onClick={() => setAdding(true)} className="mt-4 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-semibold hover:bg-purple-700 cursor-pointer">Add bank account</button>
        </div>
      )}

      {account && view.name === 'home' && (
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-600 p-0.5 text-xs font-semibold" role="tablist" aria-label="Bank reconciliation sections">
          <button type="button" id="bankTabStatements" role="tab" aria-selected={homeTab === 'statements'} onClick={() => setHomeTab('statements')} className={`px-3 py-1.5 rounded-md cursor-pointer ${homeTab === 'statements' ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>Statements</button>
          <button type="button" id="bankTabTransactions" role="tab" aria-selected={homeTab === 'transactions'} onClick={() => setHomeTab('transactions')} className={`px-3 py-1.5 rounded-md cursor-pointer ${homeTab === 'transactions' ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>Transactions &amp; search</button>
        </div>
      )}

      {account && view.name === 'home' && homeTab === 'transactions' && <TransactionSearch key={account.id} branchId={branchId} account={account} />}

      {account && view.name === 'home' && homeTab === 'statements' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-gray-900 dark:text-white">Statements</h3>
            <button type="button" id="bankUploadBtn" onClick={() => setView({ name: 'upload' })} className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-semibold hover:bg-purple-700 cursor-pointer">Upload statement</button>
          </div>
          {statements.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">No statements yet. Upload one to see what matches your books.</div>
          ) : (
            <div className="space-y-2" id="bankStatements">
              {statements.map((s) => {
                const open = (s.counts.UNMATCHED ?? 0) + (s.counts.SUGGESTED ?? 0);
                return (
                  <div key={s.id} data-statement={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                    <div>
                      <div className="font-semibold text-gray-900 dark:text-white">{s.periodStart} → {s.periodEnd}{' '}
                        <Badge tone={s.status === 'RECONCILED' ? 'good' : 'info'}>{s.status === 'RECONCILED' ? 'Reconciled' : 'In progress'}</Badge>
                        {s.balanceCheck?.status === 'FAIL' && <> <Badge tone="bad">balance check failed</Badge></>}
                        {s.balanceCheck?.status === 'UNVERIFIABLE' && <> <Badge tone="warn">not verified</Badge></>}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{s.originalFilename} · {s.source} · {s.lineCount} lines{s.duplicateCount ? ` (+${s.duplicateCount} already imported)` : ''} · closing {s.closingBalance ? inr(s.closingBalance) : 'unknown'}</div>
                      <div className="text-xs mt-1 text-gray-600 dark:text-gray-300">{open > 0 ? <b>{open} to review</b> : 'Nothing to review'} · {s.counts.MATCHED ?? 0} matched · {s.counts.IGNORED ?? 0} ignored</div>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" data-action="open-statement" onClick={() => setView({ name: 'reconcile', statementId: s.id })} className="px-3 py-2 text-sm rounded-lg bg-purple-600 text-white font-semibold hover:bg-purple-700 cursor-pointer">{s.status === 'RECONCILED' ? 'View' : 'Reconcile'}</button>
                      <ProtectedButton
                        variant="secondary"
                        minRole="manager"
                        confirmMessage={`Delete the statement ${s.periodStart} → ${s.periodEnd}? Its lines and matches are removed. Entries posted to your books stay (a statement that posted any cannot be deleted).`}
                        confirmLabel="Delete"
                        onClick={() => deleteStatement(s)}
                        className="px-3 py-2 text-sm border dark:border-gray-600 text-gray-500 hover:text-red-600"
                      >
                        Delete
                      </ProtectedButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {account && view.name === 'home' && homeTab === 'statements' && <IgnoreRules key={account.id} account={account} />}

      {account && view.name === 'upload' && (
        <UploadStatement account={account} onCancel={() => setView({ name: 'home' })}
          onImported={(id) => { showToast('Statement imported and matched against your books', 'success'); void loadStatements(); setView({ name: 'reconcile', statementId: id }); }} />
      )}

      {account && view.name === 'reconcile' && (
        <ReconcileStatement
          statementId={view.statementId}
          onBack={() => { setView({ name: 'home' }); void loadStatements(); }}
          onReconciled={() => {
            setView({ name: 'home' });
            setHomeTab('transactions');
            void loadStatements();
          }}
        />
      )}

      {adding && (
        <AddAccountModal branchId={branchId} isOwner={isOwner} onClose={() => setAdding(false)}
          onAdded={(a) => { setAdding(false); void loadAccounts(a.id); showToast('Bank account added', 'success'); }} />
      )}
    </div>
  );
}

function AddAccountModal({ branchId, isOwner, onClose, onAdded }: { branchId: string; isOwner: boolean; onClose: () => void; onAdded: (a: Account) => void }) {
  const [name, setName] = useState('');
  const [bankName, setBankName] = useState('');
  const [last4, setLast4] = useState('');
  const [scope, setScope] = useState<Scope>('BRANCH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const a = await api.post<Account>('/bank/accounts', {
        branchId, name: name.trim(), scope,
        ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
        ...(last4.trim() ? { accountLast4: last4.trim() } : {}),
      });
      onAdded(a);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  return (
    <Modal title="Add a bank account" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" hint="Anything you will recognise, e.g. “HDFC Current”.">
          <input id="bankAccName" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank (optional)">
            <input id="bankAccBank" value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={80} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
          </Field>
          <Field label="Last 4 digits (optional)">
            <input id="bankAccLast4" value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Whose books is this account checked against?</legend>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="radio" name="scope" checked={scope === 'BRANCH'} onChange={() => setScope('BRANCH')} className="mt-1" />
            <span><b>This branch only</b><span className="block text-xs text-gray-500">The statement is matched with this branch's bank ledger.</span></span>
          </label>
          <label className={`flex items-start gap-2 text-sm ${isOwner ? 'cursor-pointer' : 'opacity-50'}`}>
            <input id="bankScopeShared" type="radio" name="scope" disabled={!isOwner} checked={scope === 'SYNDICATE'} onChange={() => setScope('SYNDICATE')} className="mt-1" />
            <span><b>All outlets of the business</b><span className="block text-xs text-gray-500">One account that several outlets pay into. Matched with every outlet's bank ledger; entries you post go to this branch's books.{!isOwner && ' (Owner only.)'}</span></span>
          </label>
        </fieldset>
        {error && <div role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border dark:border-gray-600 cursor-pointer">Cancel</button>
          <button type="button" id="bankAccSave" disabled={busy || name.trim().length < 2 || !branchId} onClick={() => void submit()}
            className="px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-semibold hover:bg-purple-700 disabled:opacity-50 cursor-pointer">Add account</button>
        </div>
      </div>
    </Modal>
  );
}
