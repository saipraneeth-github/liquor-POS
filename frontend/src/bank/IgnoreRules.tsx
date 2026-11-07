import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Field, Modal, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { IGNORE_REASONS, IGNORE_REASON_LABEL, type Account, type IgnoreReason, type IgnoreRule, type RuleDraft } from './types';

const SIDE_LABEL = { ANY: 'money in or out', IN: 'money in only', OUT: 'money out only' } as const;

/** Saved "ignore lines like this" rules for one bank account: see what they have done, change them, remove them. */
export function IgnoreRules({ account }: { account: Account }) {
  const [rules, setRules] = useState<IgnoreRule[]>([]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try { setRules(await api.get<IgnoreRule[]>(`/bank/accounts/${account.id}/rules`)); }
    catch (err) { showToast(errorMessage(err), 'error'); }
  }, [account.id]);
  useEffect(() => { void load(); }, [load]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    try { await api.patch(`/bank/rules/${id}`, body); await load(); } catch (err) { showToast(errorMessage(err), 'error'); }
  };
  const remove = async (r: IgnoreRule) => {
    if (!window.confirm(`Delete the rule “${r.pattern}”? Lines it already ignored stay ignored; it just stops acting on new statements.`)) return;
    try { await api.delete(`/bank/rules/${r.id}`); showToast('Rule deleted', 'success'); await load(); } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  return (
    <div id="bankRules" className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
      <button type="button" id="bankRulesToggle" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer">
        <span>
          <span className="font-bold text-gray-900 dark:text-white">Ignore rules</span>
          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">for personal or non-store transactions · {rules.length} rule{rules.length === 1 ? '' : 's'}</span>
        </span>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-100 dark:border-gray-700 pt-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            A rule looks for text in the narration (for example a merchant or a person&apos;s name) and either suggests ignoring the line or ignores it for you.
            A line that matches something in your books is never ignored. You can also create a rule while ignoring a line.
          </p>
          {rules.length === 0 ? (
            <div className="text-sm text-gray-500">No rules yet.</div>
          ) : (
            <div className="space-y-2">
              {rules.map((r) => (
                <div key={r.id} data-rule={r.pattern} className={`flex flex-wrap items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 ${r.isActive ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-gray-900 dark:text-white break-words">“{r.pattern}” <Badge tone="muted">{IGNORE_REASON_LABEL[r.reason]}</Badge></div>
                    <div className="text-xs text-gray-500">
                      {SIDE_LABEL[r.side]}
                      {r.minAmount || r.maxAmount ? ` · ${r.minAmount ? inr(r.minAmount) : '₹0'} to ${r.maxAmount ? inr(r.maxAmount) : 'any amount'}` : ''}
                      {' · '}ignored {r.ignoredLines} line{r.ignoredLines === 1 ? '' : 's'} so far
                    </div>
                  </div>
                  <select aria-label={`Action for ${r.pattern}`} data-rule-action value={r.action} onChange={(e) => void patch(r.id, { action: e.target.value })}
                    className="p-1.5 border rounded-lg text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                    <option value="SUGGEST">Suggest only</option>
                    <option value="AUTO">Ignore automatically</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs cursor-pointer">
                    <input type="checkbox" checked={r.isActive} onChange={(e) => void patch(r.id, { isActive: e.target.checked })} /> On
                  </label>
                  <button type="button" data-rule-delete onClick={() => void remove(r)} className="text-xs text-gray-500 hover:text-red-600 cursor-pointer">Delete</button>
                </div>
              ))}
            </div>
          )}
          <button type="button" id="bankRuleAdd" onClick={() => setAdding(true)} className="px-3 py-2 text-xs rounded-lg border dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">+ Add a rule</button>
        </div>
      )}
      {adding && <AddRuleModal accountId={account.id} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); showToast('Rule saved. It applies to your next import, or press “Re-run matching” on a statement.', 'success'); void load(); }} />}
    </div>
  );
}

function AddRuleModal({ accountId, onClose, onAdded }: { accountId: string; onClose: () => void; onAdded: () => void }) {
  const [pattern, setPattern] = useState('');
  const [side, setSide] = useState<RuleDraft['side']>('OUT');
  const [reason, setReason] = useState<IgnoreReason>('PERSONAL');
  const [action, setAction] = useState<RuleDraft['action']>('SUGGEST');
  const [minAmount, setMin] = useState('');
  const [maxAmount, setMax] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/bank/accounts/${accountId}/rules`, {
        pattern: pattern.trim(), side, reason, action, ...(minAmount ? { minAmount } : {}), ...(maxAmount ? { maxAmount } : {}),
      });
      onAdded();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  return (
    <Modal title="Add an ignore rule" onClose={onClose}>
      <div className="space-y-3">
        <Field label="When the narration contains" hint="A merchant or a name, e.g. SWIGGY. Any case. At least 3 characters.">
          <input id="bankNewRulePattern" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={80} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Which lines">
            <select value={side} onChange={(e) => setSide(e.target.value as RuleDraft['side'])} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
              <option value="OUT">Money out only</option><option value="IN">Money in only</option><option value="ANY">Both</option>
            </select>
          </Field>
          <Field label="Why is it not the store's?">
            <select value={reason} onChange={(e) => setReason(e.target.value as IgnoreReason)} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
              {IGNORE_REASONS.map((r) => <option key={r} value={r}>{IGNORE_REASON_LABEL[r]}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From ₹ (optional)"><input inputMode="decimal" value={minAmount} onChange={(e) => setMin(e.target.value)} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" /></Field>
          <Field label="Up to ₹ (optional)"><input inputMode="decimal" value={maxAmount} onChange={(e) => setMax(e.target.value)} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" /></Field>
        </div>
        <Field label="What to do">
          <select value={action} onChange={(e) => setAction(e.target.value as RuleDraft['action'])} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
            <option value="SUGGEST">Suggest ignoring (I confirm each time)</option>
            <option value="AUTO">Ignore automatically</option>
          </select>
        </Field>
        {error && <div role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border dark:border-gray-600 cursor-pointer">Cancel</button>
          <button type="button" id="bankNewRuleSave" disabled={busy || pattern.trim().length < 3} onClick={() => void submit()} className="px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-semibold hover:bg-purple-700 disabled:opacity-50 cursor-pointer">Save rule</button>
        </div>
      </div>
    </Modal>
  );
}
