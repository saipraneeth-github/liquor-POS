import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { Field, Modal, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { IGNORE_REASONS, IGNORE_REASON_LABEL, isZero, type IgnoreReason, type Line, type RuleDraft } from './types';

const isOpen = (l: Line) => l.status === 'UNMATCHED' || l.status === 'SUGGESTED';
const isIn = (l: Line) => !isZero(l.credit);

/** Ignore one line or a whole selection: a reason is required, and the user can save "ignore lines like this". */
export function IgnoreModal({ targets, allLines, statementId, onClose, onDone }: {
  targets: Line[]; allLines: Line[]; statementId: string; onClose: () => void; onDone: () => void;
}) {
  const many = targets.length > 1;
  const allOut = targets.every((l) => !isIn(l));
  const allIn = targets.every((l) => isIn(l));
  const [reason, setReason] = useState<IgnoreReason>('PERSONAL');
  const [note, setNote] = useState('');
  const [makeRule, setMakeRule] = useState(false);
  const [pattern, setPattern] = useState(targets[0]?.suggestedPattern ?? '');
  const [side, setSide] = useState<RuleDraft['side']>(allOut ? 'OUT' : allIn ? 'IN' : 'ANY');
  const [action, setAction] = useState<RuleDraft['action']>('SUGGEST');
  const [limit, setLimit] = useState(false);
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const patternOk = pattern.trim().length >= 3;

  // How many OTHER open lines in this statement the rule would catch (an estimate: same simple text test the server uses)
  const alsoCatches = useMemo(() => {
    if (!makeRule || !patternOk) return 0;
    const p = pattern.trim().toLowerCase();
    const targetIds = new Set(targets.map((t) => t.id));
    return allLines.filter((l) => {
      if (!isOpen(l) || targetIds.has(l.id)) return false;
      if (!`${l.narration} ${l.reference ?? ''}`.toLowerCase().includes(p)) return false;
      if (side === 'IN' && !isIn(l)) return false;
      if (side === 'OUT' && isIn(l)) return false;
      const amt = Number(isIn(l) ? l.credit : l.debit);
      if (limit && minAmount && amt < Number(minAmount)) return false;
      if (limit && maxAmount && amt > Number(maxAmount)) return false;
      return true;
    }).length;
  }, [makeRule, patternOk, pattern, side, limit, minAmount, maxAmount, allLines, targets]);

  const total = targets.reduce((a, l) => a + Number(isIn(l) ? l.credit : l.debit), 0);

  const submit = async () => {
    setBusy(true);
    try {
      const rule: RuleDraft | undefined = makeRule && patternOk
        ? { pattern: pattern.trim(), side, action, ...(limit && minAmount ? { minAmount } : {}), ...(limit && maxAmount ? { maxAmount } : {}) }
        : undefined;
      const body = { reason, ...(note.trim() ? { note: note.trim() } : {}), ...(rule ? { rule } : {}) };
      const res = many
        ? await api.post<{ ignored: number; rule: { applied: { autoIgnored: number; suggested: number } } | null }>(`/bank/statements/${statementId}/ignore`, { lineIds: targets.map((t) => t.id), ...body })
        : await api.post<{ rule: { applied: { autoIgnored: number; suggested: number } } | null }>(`/bank/lines/${targets[0].id}/ignore`, body);
      const applied = res.rule?.applied;
      showToast(
        `${many ? `${targets.length} lines` : 'Line'} left out of the books${rule ? ` · rule saved${applied ? ` (${applied.autoIgnored} more ignored, ${applied.suggested} suggested)` : ''}` : ''}`,
        'success',
      );
      onDone();
    } catch (err) { showToast(errorMessage(err), 'error'); setBusy(false); }
  };

  return (
    <Modal title={many ? `Ignore ${targets.length} lines (${inr(total)})` : `Ignore ${inr(total)}`} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
        {many ? 'These lines' : `“${targets[0].narration}”`} will be left out of your books: no entry is posted, and {many ? 'they' : 'it'} no longer
        {' '}need{many ? '' : 's'} a decision. You can bring {many ? 'them' : 'it'} back any time from the Ignored list.
      </p>
      <div className="space-y-3">
        <Field label="Why is it not the store's?">
          <select id="bankIgnoreReason" value={reason} onChange={(e) => setReason(e.target.value as IgnoreReason)}
            className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
            {IGNORE_REASONS.map((r) => <option key={r} value={r}>{IGNORE_REASON_LABEL[r]}</option>)}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input id="bankIgnoreNote" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Owner's lunch"
            className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
        </Field>

        <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer text-gray-800 dark:text-gray-200">
            <input id="bankIgnoreMakeRule" type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
            Also handle lines like this from now on
          </label>
          {makeRule && (
            <div className="mt-3 space-y-3">
              <Field label="When the narration contains" hint="Any case. At least 3 characters, so a rule can never swallow a whole statement.">
                <input id="bankRulePattern" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={80}
                  className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Which lines">
                  <select id="bankRuleSide" value={side} onChange={(e) => setSide(e.target.value as RuleDraft['side'])}
                    className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                    <option value="OUT">Money out only</option>
                    <option value="IN">Money in only</option>
                    <option value="ANY">Both</option>
                  </select>
                </Field>
                <Field label="What to do">
                  <select id="bankRuleAction" value={action} onChange={(e) => setAction(e.target.value as RuleDraft['action'])}
                    className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                    <option value="SUGGEST">Suggest ignoring (I confirm)</option>
                    <option value="AUTO">Ignore automatically</option>
                  </select>
                </Field>
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer text-gray-600 dark:text-gray-300">
                <input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} /> Only for amounts between…
              </label>
              {limit && (
                <div className="grid grid-cols-2 gap-3">
                  <input id="bankRuleMin" inputMode="decimal" placeholder="from ₹" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} className="p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  <input id="bankRuleMax" inputMode="decimal" placeholder="up to ₹" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} className="p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                </div>
              )}
              {patternOk && <p id="bankRuleCatch" className="text-xs text-gray-600 dark:text-gray-300">This would also catch about <b>{alsoCatches}</b> other open line{alsoCatches === 1 ? '' : 's'} in this statement.</p>}
              {action === 'AUTO' && (
                <p className="text-xs rounded bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 p-2">
                  Matching lines will be ignored without asking. A line that matches something in your books is never ignored, and every
                  automatic decision is labelled with its rule and can be undone from the Ignored list.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border dark:border-gray-600 cursor-pointer">Cancel</button>
          <button type="button" id="bankIgnoreConfirm" disabled={busy || (makeRule && !patternOk)} onClick={() => void submit()}
            className="px-4 py-2 text-sm rounded-lg bg-gray-800 text-white font-semibold hover:bg-gray-900 disabled:opacity-50 cursor-pointer dark:bg-gray-600">
            Ignore{many ? ` ${targets.length} lines` : ''}
          </button>
        </div>
      </div>
    </Modal>
  );
}
