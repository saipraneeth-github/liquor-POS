import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Badge, Field, Modal, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { IgnoreModal } from './IgnoreModal';
import {
  CATEGORY_LABEL, IGNORE_REASON_LABEL, isZero, type Account, type Candidate, type Category, type Line, type LineStatus, type StatementRow, type Summary,
} from './types';

const isOpenLine = (l: Line) => l.status === 'UNMATCHED' || l.status === 'SUGGESTED';

type Detail = { statement: StatementRow; account: Account; counts: Record<string, number> };
type Filter = 'REVIEW' | 'ALL' | LineStatus;

const IN_CATEGORIES: Array<{ id: Category; label: string; effect: string }> = [
  { id: 'CASH_DEPOSIT', label: 'Cash deposit', effect: 'Moves cash from the till into the bank (Dr Bank, Cr Cash)' },
  { id: 'INTEREST', label: 'Interest received', effect: 'Records income (Dr Bank, Cr Interest income)' },
  { id: 'OTHER_RECEIPT', label: 'Other receipt…', effect: 'Choose the account it belongs to (Dr Bank, Cr that account)' },
];
const OUT_CATEGORIES: Array<{ id: Category; label: string; effect: string }> = [
  { id: 'BANK_CHARGE', label: 'Bank charge / fee', effect: 'Records an expense (Dr Bank charges, Cr Bank)' },
  { id: 'CASH_WITHDRAWAL', label: 'Cash withdrawal', effect: 'Moves cash from the bank into the till (Dr Cash, Cr Bank)' },
  { id: 'SUPPLIER_PAYMENT', label: 'Supplier payment', effect: 'Reduces what you owe suppliers (Dr Sundry creditors, Cr Bank)' },
  { id: 'OTHER_PAYMENT', label: 'Other payment…', effect: 'Choose the account it belongs to (Dr that account, Cr Bank)' },
];

const statusTone = (s: LineStatus) => (s === 'MATCHED' ? 'good' : s === 'SUGGESTED' ? 'info' : s === 'IGNORED' ? 'muted' : 'warn') as 'good' | 'info' | 'muted' | 'warn';

export function ReconcileStatement({ statementId, onBack }: { statementId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [filter, setFilter] = useState<Filter>('REVIEW');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [postFor, setPostFor] = useState<Line | null>(null);
  const [matchFor, setMatchFor] = useState<Line | null>(null);
  const [ignoreTargets, setIgnoreTargets] = useState<Line[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDifference, setConfirmDifference] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, l, s] = await Promise.all([
        api.get<Detail>(`/bank/statements/${statementId}`),
        api.get<Line[]>(`/bank/statements/${statementId}/lines?limit=500`),
        api.get<Summary>(`/bank/statements/${statementId}/summary`),
      ]);
      setDetail(d);
      setLines(l);
      setSummary(s);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); showToast(ok, 'success'); await load(); } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  const shown = useMemo(() => lines.filter((l) => {
    if (filter === 'REVIEW' && !(l.status === 'UNMATCHED' || l.status === 'SUGGESTED')) return false;
    if (filter !== 'REVIEW' && filter !== 'ALL' && l.status !== filter) return false;
    if (search.trim() && !`${l.narration} ${l.reference ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  }), [lines, filter, search]);

  if (loading || !detail) return <div className="text-sm text-gray-500">Loading statement…</div>;
  const { statement, account } = detail;
  const counts = detail.counts;
  const open = (counts.UNMATCHED ?? 0) + (counts.SUGGESTED ?? 0);
  const ignoreSuggested = lines.filter((l) => l.status === 'SUGGESTED' && l.suggestion?.kind === 'IGNORE').length;
  const openShown = shown.filter(isOpenLine);
  const selectedLines = lines.filter((l) => selected.has(l.id) && isOpenLine(l));
  const allShownSelected = openShown.length > 0 && openShown.every((l) => selected.has(l.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const confirmIgnore = (l: Line) => {
    const s = l.suggestion;
    if (s?.kind !== 'IGNORE') return;
    void act(() => api.post(`/bank/lines/${l.id}/ignore`, { reason: s.ignoreReason, ruleId: s.ruleId, note: `Confirmed rule “${s.pattern}”` }), 'Left out of the books');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button type="button" onClick={onBack} className="text-xs text-gray-500 hover:underline cursor-pointer">← All statements</button>
          <h3 className="text-base font-bold text-gray-900 dark:text-white">
            {account.name}: {statement.periodStart} → {statement.periodEnd}{' '}
            <Badge tone={statement.status === 'RECONCILED' ? 'good' : 'info'}>{statement.status === 'RECONCILED' ? 'Reconciled' : 'In progress'}</Badge>
          </h3>
          <p className="text-xs text-gray-500">{statement.originalFilename} · {statement.lineCount} lines · closing {statement.closingBalance ? inr(statement.closingBalance) : 'unknown'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" id="bankRematch" className="px-3 py-2 text-xs rounded-lg border dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
            onClick={() => void act(() => api.post(`/bank/statements/${statementId}/match`), 'Matching re-run')}>Re-run matching</button>
          <button type="button" id="bankAcceptAll" className="px-3 py-2 text-xs rounded-lg bg-purple-600 text-white font-semibold hover:bg-purple-700 cursor-pointer"
            onClick={() => void act(async () => {
              const r = await api.post<{ accepted: number; skipped: number }>(`/bank/statements/${statementId}/accept-suggestions`, {});
              showToast(`${r.accepted} accepted, ${r.skipped} left for you to review`, 'success');
            }, 'Done')}>Accept all high-confidence matches</button>
          {ignoreSuggested > 0 && (
            <button type="button" id="bankApplyIgnores" className="px-3 py-2 text-xs rounded-lg border border-gray-400 dark:border-gray-500 text-gray-800 dark:text-gray-100 font-semibold hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
              onClick={() => void act(async () => {
                const r = await api.post<{ ignored: number }>(`/bank/statements/${statementId}/apply-ignore-suggestions`);
                showToast(`${r.ignored} line${r.ignored === 1 ? '' : 's'} ignored by your rules`, 'success');
              }, 'Done')}>Ignore suggested ({ignoreSuggested})</button>
          )}
          <button type="button" id="bankFinalize" disabled={open > 0 || statement.status === 'RECONCILED'}
            className="px-3 py-2 text-xs rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-40 cursor-pointer"
            title={open > 0 ? `${open} line(s) still need a decision` : ''}
            onClick={() => {
              // Every line is handled, but if the totals still differ say so first: usually the books lack the opening balance
              const diff = summary?.summary.difference;
              if (diff !== undefined && diff !== null && !isZero(diff)) setConfirmDifference(diff);
              else void act(() => api.post(`/bank/statements/${statementId}/finalize`), 'Statement reconciled');
            }}>Mark reconciled</button>
        </div>
      </div>

      {summary && <SummaryCard s={summary} />}

      {confirmDifference !== null && (
        <Modal title="Mark as reconciled with a difference?" onClose={() => setConfirmDifference(null)}>
          <div className="space-y-3 text-sm" id="bankDifferenceDialog">
            <p>
              Every line on this statement is handled, but the bank and your books still differ by <b className="font-mono">{inr(confirmDifference)}</b>.
              This usually means an opening balance from before this statement that is not in your books.
            </p>
            <p className="text-gray-500">If that explains it, you can mark the statement reconciled. If not, go back and check the lines first.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" id="bankFinalizeCancel" className="px-4 py-2 rounded-lg border dark:border-gray-600 text-sm cursor-pointer" onClick={() => setConfirmDifference(null)}>Go back</button>
              <button type="button" id="bankFinalizeAnyway" className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-semibold text-sm cursor-pointer"
                onClick={() => { setConfirmDifference(null); void act(() => api.post(`/bank/statements/${statementId}/finalize`), 'Statement reconciled'); }}>
                Mark reconciled anyway
              </button>
            </div>
          </div>
        </Modal>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {([['REVIEW', `To review (${open})`], ['MATCHED', `Matched (${counts.MATCHED ?? 0})`], ['IGNORED', `Ignored (${counts.IGNORED ?? 0})`], ['ALL', `All (${lines.length})`]] as Array<[Filter, string]>).map(([f, label]) => (
          <button key={f} type="button" data-filter={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer ${filter === f ? 'bg-purple-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>{label}</button>
        ))}
        <input id="bankLineSearch" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search narration or reference"
          className="ml-auto p-2 border rounded-lg text-xs w-56 dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
      </div>

      {selectedLines.length > 0 && (
        <div id="bankBulkBar" className="flex flex-wrap items-center gap-3 px-4 py-2 rounded-lg bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-sm">
          <b>{selectedLines.length} selected</b>
          <button type="button" id="bankBulkIgnore" onClick={() => setIgnoreTargets(selectedLines)} className="px-3 py-1.5 rounded-lg bg-gray-800 text-white text-xs font-semibold hover:bg-gray-900 cursor-pointer dark:bg-gray-600">Ignore selected…</button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-gray-500 hover:underline cursor-pointer">Clear</button>
        </div>
      )}

      <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800">
        <table className="min-w-full text-xs" id="bankLinesTable">
          <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300">
            <tr>
              <th className="px-3 py-2 w-8">
                <input type="checkbox" id="bankSelectAll" aria-label="Select all open lines shown" disabled={openShown.length === 0} checked={allShownSelected}
                  onChange={() => setSelected(allShownSelected ? new Set() : new Set(openShown.map((l) => l.id)))} />
              </th>
              {['Date', 'Narration', 'Money in', 'Money out', 'Status', 'What we found', 'Action'].map((h) => <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">{filter === 'REVIEW' ? 'Nothing left to review. ' : 'No lines.'}</td></tr>}
            {shown.map((l) => (
              <tr key={l.id} data-line-status={l.status} className="border-t border-gray-100 dark:border-gray-700 align-top">
                <td className="px-3 py-2">{isOpenLine(l) && <input type="checkbox" data-select={l.id} aria-label={`Select ${l.narration}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />}</td>
                <td className="px-3 py-2 whitespace-nowrap">{l.txnDate}</td>
                <td className="px-3 py-2 max-w-xs">
                  <div className="truncate" title={l.narration}>{l.narration || '—'}</div>
                  {l.reference && <div className="font-mono text-[10px] text-gray-400">{l.reference}</div>}
                </td>
                <td className="px-3 py-2 text-right font-mono text-emerald-600 dark:text-emerald-400">{isZero(l.credit) ? '' : inr(l.credit)}</td>
                <td className="px-3 py-2 text-right font-mono text-red-600 dark:text-red-400">{isZero(l.debit) ? '' : inr(l.debit)}</td>
                <td className="px-3 py-2"><Badge tone={statusTone(l.status)}>{l.status.toLowerCase()}</Badge></td>
                <td className="px-3 py-2 max-w-sm">
                  <Finding line={l} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <Actions line={l}
                    onAccept={() => void act(() => api.post(`/bank/lines/${l.id}/accept`, {}), 'Matched')}
                    onPost={() => setPostFor(l)} onMatch={() => setMatchFor(l)}
                    onIgnore={() => setIgnoreTargets([l])} onConfirmIgnore={() => confirmIgnore(l)}
                    onUnmatch={() => void act(() => api.post(`/bank/lines/${l.id}/unmatch`), 'Reopened')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {postFor && <PostModal line={postFor} account={account} onClose={() => setPostFor(null)} onDone={() => { setPostFor(null); void load(); }} />}
      {matchFor && <MatchModal line={matchFor} onClose={() => setMatchFor(null)} onDone={() => { setMatchFor(null); void load(); }} />}
      {ignoreTargets && (
        <IgnoreModal targets={ignoreTargets} allLines={lines} statementId={statementId} onClose={() => setIgnoreTargets(null)}
          onDone={() => { setIgnoreTargets(null); setSelected(new Set()); void load(); }} />
      )}
    </div>
  );
}

function Finding({ line }: { line: Line }) {
  if (line.status === 'MATCHED') {
    return (
      <div>
        <div className="font-semibold text-gray-800 dark:text-gray-200">{CATEGORY_LABEL[line.category ?? ''] ?? line.category}</div>
        {!isZero(line.feeAmount) && <div className="text-gray-500">fee {inr(line.feeAmount)} posted as a bank charge</div>}
        {line.voucherId && <div className="text-gray-500">entry posted to your books</div>}
      </div>
    );
  }
  if (line.status === 'IGNORED') {
    return (
      <div>
        <div className="font-semibold text-gray-800 dark:text-gray-200">Left out of the books{line.ignoreReason ? `: ${IGNORE_REASON_LABEL[line.ignoreReason]}` : ''}</div>
        {line.note && <div className="text-gray-500">{line.note}</div>}
        {line.ignoredByRuleId && <div className="text-[10px] text-gray-400">decided by a saved rule: un-ignore it if it was wrong</div>}
      </div>
    );
  }
  const s = line.suggestion;
  if (!s) return <div className="text-gray-500">Not found in your books. Post it, or match it by hand.</div>;
  return (
    <div>
      <div className="text-gray-700 dark:text-gray-300">{s.reason}</div>
      <div className="text-[10px] text-gray-400">confidence {Math.round(s.confidence * 100)}%</div>
    </div>
  );
}

function Actions({ line, onAccept, onPost, onMatch, onIgnore, onConfirmIgnore, onUnmatch }: {
  line: Line; onAccept: () => void; onPost: () => void; onMatch: () => void; onIgnore: () => void; onConfirmIgnore: () => void; onUnmatch: () => void;
}) {
  const btn = 'px-2 py-1 rounded text-[11px] font-semibold cursor-pointer';
  if (line.status === 'MATCHED') {
    return line.voucherId
      ? <span className="text-[11px] text-gray-400">posted</span>
      : <button type="button" data-action="unmatch" className={`${btn} border dark:border-gray-600`} onClick={onUnmatch}>Un-match</button>;
  }
  if (line.status === 'IGNORED') return <button type="button" data-action="unmatch" className={`${btn} border dark:border-gray-600`} onClick={onUnmatch}>Un-ignore</button>;
  const s = line.suggestion;
  const canAccept = s && (s.kind === 'ONE_TO_ONE' || s.kind === 'SETTLEMENT');
  if (s?.kind === 'IGNORE') {
    return (
      <div className="flex flex-wrap gap-1.5">
        <button type="button" data-action="confirm-ignore" className={`${btn} bg-gray-800 text-white hover:bg-gray-900 dark:bg-gray-600`} onClick={onConfirmIgnore}>Ignore ({IGNORE_REASON_LABEL[s.ignoreReason].split(' ')[0].toLowerCase()})</button>
        <button type="button" data-action="post" className={`${btn} border dark:border-gray-600`} onClick={onPost}>Post to books…</button>
        <button type="button" data-action="match" className={`${btn} border dark:border-gray-600`} onClick={onMatch}>Match entries…</button>
        <button type="button" data-action="ignore" className={`${btn} border dark:border-gray-600 text-gray-500`} onClick={onIgnore}>Ignore…</button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {canAccept &&<button type="button" data-action="accept" className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`} onClick={onAccept}>{s.kind === 'SETTLEMENT' ? `Accept (fee ${inr(s.fee)})` : 'Accept'}</button>}
      <button type="button" data-action="post" className={`${btn} ${canAccept ? 'border dark:border-gray-600' : 'bg-purple-600 text-white hover:bg-purple-700'}`} onClick={onPost}>
        {s?.kind === 'POST' ? `Post as ${CATEGORY_LABEL[s.category].toLowerCase()}` : 'Post to books…'}
      </button>
      <button type="button" data-action="match" className={`${btn} border dark:border-gray-600`} onClick={onMatch}>Match entries…</button>
      <button type="button" data-action="ignore" className={`${btn} border dark:border-gray-600 text-gray-500`} onClick={onIgnore}>Ignore…</button>
    </div>
  );
}

function Row({ label, value, sign, strong }: { label: string; value: string | null; sign?: '+' | '−' | '='; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 py-1 ${strong ? 'font-bold border-t border-gray-200 dark:border-gray-600 mt-1 pt-2' : ''}`}>
      <span className="text-gray-600 dark:text-gray-300">{sign && <span className="inline-block w-4 text-gray-400">{sign}</span>}{label}</span>
      <span className="font-mono">{value === null ? '—' : inr(value)}</span>
    </div>
  );
}

function SummaryCard({ s }: { s: Summary }) {
  const x = s.summary;
  return (
    <div id="bankSummary" data-reconciled={x.reconciled} className="grid md:grid-cols-2 gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm">
      <div>
        <div className="text-xs font-bold text-gray-500 mb-1">BANK RECONCILIATION as at {s.asAt}</div>
        <Row label="Balance per bank statement" value={x.bankClosing} />
        <Row label="Receipts in your books, not yet in the bank" value={x.outstandingReceipts} sign="+" />
        <Row label="Payments in your books, not yet cleared" value={x.outstandingPayments} sign="−" />
        <Row label="Bank credits not yet in your books" value={x.unpostedReceipts} sign="−" />
        <Row label="Bank debits not yet in your books" value={x.unpostedPayments} sign="+" />
        {Number(x.ignoredNet) !== 0 && <Row label="Ignored lines" value={x.ignoredNet} sign="−" />}
        <Row label="Adjusted bank balance" value={x.adjustedBank} sign="=" strong />
        {s.ignored.count > 0 && (
          <div id="bankIgnoredSummary" className="mt-3 p-2 rounded-lg bg-gray-50 dark:bg-gray-700/40 text-xs text-gray-600 dark:text-gray-300">
            <b>Left out of the books on this statement:</b> {s.ignored.count} line{s.ignored.count === 1 ? '' : 's'}
            {' · '}{inr(s.ignored.totalOut)} out{Number(s.ignored.totalIn) > 0 ? `, ${inr(s.ignored.totalIn)} in` : ''}
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
              {s.ignored.byReason.map((r) => (
                <span key={r.reason}>{IGNORE_REASON_LABEL[r.reason] ?? r.reason}: {r.count} ({inr(Number(r.out) > 0 ? r.out : r.in)})</span>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col justify-between">
        <div>
          <div className="text-xs font-bold text-gray-500 mb-1">YOUR BOOKS</div>
          <Row label="Balance per books (Bank ledger)" value={x.bookBalance} />
        </div>
        <div data-state={x.reconciled ? 'reconciled' : x.booksComplete ? 'difference' : 'incomplete'}
          className={`mt-3 p-3 rounded-lg border ${x.reconciled ? 'bg-emerald-50 border-emerald-300 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-200' : 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200'}`}>
          {x.reconciled ? (
            <b>✓ Reconciled: your books and the bank agree.</b>
          ) : !x.booksComplete ? (
            <>
              <b>Not reconciled yet: some bank lines are missing from your books.</b>
              <div className="text-xs mt-1">
                The figures tie out only because those lines are listed above as reconciling items ({inr(x.unpostedReceipts)} money in, {inr(x.unpostedPayments)} money out).
                Post or match each line below, and this card will turn green.
              </div>
            </>
          ) : (
            <>
              <b>Difference: {x.difference === null ? 'unknown (no closing balance)' : inr(x.difference)}</b>
              <div className="text-xs mt-1">Every line is handled, but the totals still differ. This usually means an opening-balance difference from before this statement.</div>
            </>
          )}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">{s.note}</p>
      </div>
    </div>
  );
}

function PostModal({ line, account, onClose, onDone }: { line: Line; account: Account; onClose: () => void; onDone: () => void }) {
  const isIn = !isZero(line.credit);
  const options = isIn ? IN_CATEGORIES : OUT_CATEGORIES;
  const hinted = line.suggestion?.kind === 'POST' ? line.suggestion.category : null;
  const [category, setCategory] = useState<Category>(hinted && options.some((o) => o.id === hinted) ? hinted : options[0].id);
  const [ledgerId, setLedgerId] = useState('');
  const [ledgers, setLedgers] = useState<{ id: string; code: string; name: string }[]>([]);
  const [narration, setNarration] = useState('');
  const [busy, setBusy] = useState(false);
  const needsLedger = category === 'OTHER_RECEIPT' || category === 'OTHER_PAYMENT';
  const amount = isIn ? line.credit : line.debit;

  useEffect(() => {
    if (!needsLedger || ledgers.length) return;
    api.get<{ ledgers: { id: string; code: string; name: string }[] }>(`/accounting/ledgers/${account.branchId}`)
      .then((r) => setLedgers(r.ledgers.filter((l) => l.code !== 'BANK')))
      .catch((err) => showToast(errorMessage(err), 'error'));
  }, [needsLedger, ledgers.length, account.branchId]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/bank/lines/${line.id}/post`, { category, ...(needsLedger ? { ledgerId } : {}), ...(narration.trim() ? { narration: narration.trim() } : {}) });
      showToast('Posted to your books and matched', 'success');
      onDone();
    } catch (err) { showToast(errorMessage(err), 'error'); setBusy(false); }
  };

  return (
    <Modal title={`Post ${inr(amount)} to your books`} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">“{line.narration}” is on the bank statement but not in your books yet. Choose what it is; a voucher is created and matched to this line.</p>
      <div className="space-y-3">
        <Field label="What is it?">
          <select id="bankPostCategory" value={category} onChange={(e) => setCategory(e.target.value as Category)} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
        <p className="text-xs text-gray-500">{options.find((o) => o.id === category)?.effect}</p>
        {needsLedger && (
          <Field label="Account">
            <select id="bankPostLedger" value={ledgerId} onChange={(e) => setLedgerId(e.target.value)} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
              <option value="">Choose an account…</option>
              {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Note (optional)">
          <input value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={200} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border dark:border-gray-600 cursor-pointer">Cancel</button>
          <button type="button" id="bankPostConfirm" disabled={busy || (needsLedger && !ledgerId)} onClick={() => void submit()}
            className="px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-semibold hover:bg-purple-700 disabled:opacity-50 cursor-pointer">Post to books</button>
        </div>
      </div>
    </Modal>
  );
}

function MatchModal({ line, onClose, onDone }: { line: Line; onClose: () => void; onDone: () => void }) {
  const isIn = !isZero(line.credit);
  const amount = Number(isIn ? line.credit : line.debit);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [postDiff, setPostDiff] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Candidate[]>(`/bank/lines/${line.id}/candidates`).then(setCands).catch((err) => showToast(errorMessage(err), 'error'));
  }, [line.id]);

  const total = (cands ?? []).filter((c) => picked.has(c.id)).reduce((a, c) => a + (isIn ? Number(c.debit) - Number(c.credit) : Number(c.credit) - Number(c.debit)), 0);
  // Same rule as the server: > 0 means the bank kept (receipt) or took (payment) this much beyond the entries;
  // < 0 means the statement shows MORE than the entries cover, which has to be posted separately.
  const fee = Math.round((isIn ? total - amount : amount - total) * 100) / 100;
  const blocked = picked.size === 0 || fee < -0.005;
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/bank/lines/${line.id}/match`, { entryIds: [...picked], postDifference: postDiff });
      showToast('Matched', 'success');
      onDone();
    } catch (err) { showToast(errorMessage(err), 'error'); setBusy(false); }
  };

  return (
    <Modal title={`Match ${inr(amount)} to book entries`} onClose={onClose} wide>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">Pick the entries in your books that this {isIn ? 'credit' : 'debit'} pays for. A settlement can cover many sales.</p>
      {cands === null ? <div className="text-sm text-gray-500">Loading…</div> : cands.length === 0 ? <div className="text-sm text-gray-500">No unmatched entries near this date.</div> : (
        <div className="max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg">
          <table className="min-w-full text-xs">
            <tbody>
              {cands.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 dark:border-gray-700">
                  <td className="px-2 py-1.5"><input type="checkbox" data-entry={c.id} checked={picked.has(c.id)} onChange={() => toggle(c.id)} /></td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{c.date}</td>
                  <td className="px-2 py-1.5">{c.narration}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{inr(Number(c.debit) > 0 ? c.debit : c.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 text-sm space-y-1">
        <div className="flex justify-between"><span>Selected entries</span><span className="font-mono">{inr(total)}</span></div>
        <div className="flex justify-between"><span>Bank statement line</span><span className="font-mono">{inr(amount)}</span></div>
        {picked.size > 0 && Math.abs(fee) > 0.005 && (
          fee > 0
            ? <label className="flex items-center gap-2 text-amber-700 dark:text-amber-300"><input id="bankPostDiff" type="checkbox" checked={postDiff} onChange={(e) => setPostDiff(e.target.checked)} />The bank kept {inr(fee)}. Post it as a bank charge.</label>
            : <div className="text-red-600 dark:text-red-400">The statement shows {inr(-fee)} more than these entries. Post that part separately.</div>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-3">
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border dark:border-gray-600 cursor-pointer">Cancel</button>
        <button type="button" id="bankMatchConfirm" disabled={busy || blocked || (fee > 0.005 && !postDiff)} onClick={() => void submit()}
          className="px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50 cursor-pointer">Match</button>
      </div>
    </Modal>
  );
}
