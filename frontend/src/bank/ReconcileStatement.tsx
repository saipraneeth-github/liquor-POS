import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Badge, Field, Modal, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { BankVsBook } from './BankVsBook';
import { IgnoreModal } from './IgnoreModal';
import {
  CATEGORY_LABEL, CUSTOM_PREFIX, IGNORE_REASON_LABEL, NEEDS_LEDGER, isZero, type Account, type Candidate, type Category, type Line, type LineDetail, type LineStatus, type StatementRow, type Summary, type TxnType,
} from './types';

const isOpenLine = (l: Line) => l.status === 'UNMATCHED' || l.status === 'SUGGESTED';

type Detail = { statement: StatementRow; account: Account; counts: Record<string, number> };
type Filter = 'REVIEW' | 'ALL' | LineStatus;

const IN_CATEGORIES: Array<{ id: Category; label: string; effect: string }> = [
  { id: 'CASH_DEPOSIT', label: 'Cash deposit', effect: 'Moves cash from the till into the bank (Dr Bank, Cr Cash)' },
  { id: 'SUPPLIER_REFUND', label: 'Supplier refund / credit', effect: 'A supplier paid you back or credited you (Dr Bank, Cr Sundry creditors)' },
  { id: 'OWNER_CAPITAL', label: 'Owner / partner money in', effect: 'Capital put in by the owner or partners (Dr Bank, Cr Capital)' },
  { id: 'INTER_ACCOUNT_IN', label: 'Transfer from own account…', effect: 'Money moved from another of your accounts; choose that account (Dr Bank, Cr that account)' },
  { id: 'INTEREST', label: 'Interest received', effect: 'Records income (Dr Bank, Cr Interest income)' },
  { id: 'OTHER_RECEIPT', label: 'Other receipt…', effect: 'Choose the account it belongs to (Dr Bank, Cr that account)' },
];
const OUT_CATEGORIES: Array<{ id: Category; label: string; effect: string }> = [
  { id: 'SALARY_WAGES', label: 'Salary / wages', effect: 'Staff pay (Dr Salaries & Wages, Cr Bank)' },
  { id: 'RENT', label: 'Rent', effect: 'Store or warehouse rent (Dr Rent Expense, Cr Bank)' },
  { id: 'UTILITIES', label: 'Electricity & utilities', effect: 'Power, water, phone, internet bills (Dr Electricity & Utilities, Cr Bank)' },
  { id: 'MISC_EXPENSES', label: 'Miscellaneous expense', effect: 'Sundry and office expenses (Dr Miscellaneous Expenses, Cr Bank)' },
  { id: 'SUPPLIER_PAYMENT', label: 'Supplier payment', effect: 'Reduces what you owe suppliers (Dr Sundry creditors, Cr Bank)' },
  { id: 'EXCISE_GOVT', label: 'Excise / government payment', effect: 'Treasury challan, DD to the Excise Commissioner, licence fee (Dr Excise & Government Dues, Cr Bank)' },
  { id: 'BANK_CHARGE', label: 'Bank charge / fee', effect: 'Records an expense (Dr Bank charges, Cr Bank)' },
  { id: 'CASH_WITHDRAWAL', label: 'Cash withdrawal', effect: 'Moves cash from the bank into the till (Dr Cash, Cr Bank)' },
  { id: 'OWNER_DRAWINGS', label: 'Owner / partner withdrawal', effect: 'Money taken out by the owner or partners (Dr Capital, Cr Bank)' },
  { id: 'INTER_ACCOUNT_OUT', label: 'Transfer to own account…', effect: 'Money moved to another of your accounts; choose that account (Dr that account, Cr Bank)' },
  { id: 'OTHER_PAYMENT', label: 'Other payment…', effect: 'Choose the account it belongs to (Dr that account, Cr Bank)' },
];

const statusTone = (s: LineStatus) => (s === 'MATCHED' ? 'good' : s === 'SUGGESTED' ? 'info' : s === 'IGNORED' ? 'muted' : 'warn') as 'good' | 'info' | 'muted' | 'warn';

export function ReconcileStatement({
  statementId,
  onBack,
  onReconciled,
}: {
  statementId: string;
  onBack: () => void;
  onReconciled?: () => void;
}) {
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
  const [direction, setDirection] = useState<'ALL' | 'IN' | 'OUT'>('ALL');
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [types, setTypes] = useState<TxnType[]>([]);
  const [addingType, setAddingType] = useState(false);
  const [view, setView] = useState<'TABLE' | 'BOOK'>('BOOK');

  const loadTypes = useCallback(async (accountId: string) => {
    try { setTypes(await api.get<TxnType[]>(`/bank/accounts/${accountId}/types`)); } catch { /* types are optional: the built-in ones still work */ }
  }, []);
  /** Names the customer's own types, falls back to the built-in labels. */
  const typeLabel = useCallback((c: string | null | undefined) => {
    if (!c) return '';
    if (c.startsWith(CUSTOM_PREFIX)) return types.find((t) => t.id === c.slice(CUSTOM_PREFIX.length))?.name ?? 'Custom type';
    return CATEGORY_LABEL[c] ?? c;
  }, [types]);

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
      void loadTypes(d.account.id);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [statementId, loadTypes]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); showToast(ok, 'success'); await load(); } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  const submitFinalize = async () => {
    try {
      await api.post(`/bank/statements/${statementId}/finalize`);
      showToast('Statement submitted & reconciled', 'success');
      if (onReconciled) {
        onReconciled();
      } else {
        await load();
      }
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  /** Direction, type and date filters: shared by the table and the side-by-side view. */
  const passesFilters = (l: Line) => {
    if (direction === 'IN' && isZero(l.credit)) return false;
    if (direction === 'OUT' && isZero(l.debit)) return false;
    if (typeFilter && (l.category ?? (l.suggestion?.kind === 'POST' ? l.suggestion.category : '')) !== typeFilter) return false;
    if (dateFrom && l.txnDate < dateFrom) return false;
    if (dateTo && l.txnDate > dateTo) return false;
    return true;
  };
  const shown = useMemo(() => lines.filter((l) => {
    if (filter === 'REVIEW' && !(l.status === 'UNMATCHED' || l.status === 'SUGGESTED')) return false;
    if (filter !== 'REVIEW' && filter !== 'ALL' && l.status !== filter) return false;
    if (!passesFilters(l)) return false;
    // Search the words of what the person typed against narration, reference and amounts, so "uti 2500" finds the right line
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      const hay = `${l.narration} ${l.reference ?? ''} ${l.txnDate} ${Number(l.debit)} ${Number(l.credit)}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }), [lines, filter, search, direction, typeFilter, dateFrom, dateTo]);
  const typesPresent = useMemo(() => {
    const set = new Set<string>();
    for (const l of lines) {
      const c = l.category ?? (l.suggestion?.kind === 'POST' ? l.suggestion.category : null);
      if (c) set.add(c);
    }
    return [...set].sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
  }, [lines, typeLabel]);

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
          <button type="button" id="bankBackToStatements" onClick={onBack} className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:underline cursor-pointer mb-0.5 inline-block">← All statements</button>
          <h3 className="text-base font-bold text-gray-900 dark:text-white">
            {account.name}: {statement.periodStart} → {statement.periodEnd}{' '}
            <Badge tone={statement.status === 'RECONCILED' ? 'good' : 'info'}>{statement.status === 'RECONCILED' ? 'Reconciled' : 'In progress'}</Badge>
          </h3>
          <p className="text-xs text-gray-500">{statement.originalFilename} · {statement.lineCount} lines · closing {statement.closingBalance ? inr(statement.closingBalance) : 'unknown'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" id="bankAddType" className="px-3 py-2 text-xs rounded-lg border border-purple-300 text-purple-700 dark:text-purple-300 font-semibold hover:bg-purple-50 dark:hover:bg-purple-950/30 cursor-pointer"
            onClick={() => setAddingType(true)}>+ Add transaction type</button>
          <button type="button" id="bankRematch"
            disabled={statement.status === 'RECONCILED'}
            className="px-3 py-2 text-xs rounded-lg border dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            title={statement.status === 'RECONCILED' ? 'Statement is already reconciled' : ''}
            onClick={() => void act(() => api.post(`/bank/statements/${statementId}/match`), 'Matching re-run')}>Re-run matching</button>
          <button type="button" id="bankAcceptAll"
            disabled={statement.status === 'RECONCILED' || (counts.SUGGESTED ?? 0) === 0}
            className="px-3 py-2 text-xs rounded-lg bg-purple-600 text-white font-semibold hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            title={statement.status === 'RECONCILED' ? 'Statement is already reconciled' : (counts.SUGGESTED ?? 0) === 0 ? 'No suggestions to accept' : ''}
            onClick={() => void act(async () => {
              const r = await api.post<{ accepted: number; skipped: number }>(`/bank/statements/${statementId}/accept-suggestions`, {});
              showToast(`${r.accepted} accepted, ${r.skipped} left for you to review`, 'success');
            }, 'Done')}>Accept all high-confidence matches</button>
          {ignoreSuggested > 0 && (
            <button type="button" id="bankApplyIgnores"
              disabled={statement.status === 'RECONCILED'}
              className="px-3 py-2 text-xs rounded-lg border border-gray-400 dark:border-gray-500 text-gray-800 dark:text-gray-100 font-semibold hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              onClick={() => void act(async () => {
                const r = await api.post<{ ignored: number }>(`/bank/statements/${statementId}/apply-ignore-suggestions`);
                showToast(`${r.ignored} line${r.ignored === 1 ? '' : 's'} ignored by your rules`, 'success');
              }, 'Done')}>Ignore suggested ({ignoreSuggested})</button>
          )}
          <button type="button" id="bankFinalize" disabled={open > 0 || statement.status === 'RECONCILED'}
            className="px-3 py-2 text-xs rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            title={statement.status === 'RECONCILED' ? 'Statement has already been submitted and reconciled' : open > 0 ? `${open} line(s) still need a decision` : ''}
            onClick={() => {
              // Every line is handled, but if the totals still differ say so first: usually the books lack the opening balance
              const diff = summary?.summary.difference;
              if (diff !== undefined && diff !== null && !isZero(diff)) setConfirmDifference(diff);
              else void submitFinalize();
            }}>{statement.status === 'RECONCILED' ? 'Statement Submitted' : 'Submit Statement'}</button>
          <button
            type="button"
            id="bankCloseStatement"
            onClick={onBack}
            className="px-3 py-2 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 font-semibold hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
            title="Close statement and return to statements list"
          >
            Close
          </button>
        </div>
      </div>

      {summary && <SummaryBar statement={statement} lines={lines} s={summary} open={open} />}

      {confirmDifference !== null && (
        <Modal title="Submit statement with a difference?" onClose={() => setConfirmDifference(null)}>
          <div className="space-y-3 text-sm" id="bankDifferenceDialog">
            <p>
              Every line on this statement is handled, but the bank and your books still differ by <b className="font-mono">{inr(confirmDifference)}</b>.
              This usually means an opening balance from before this statement that is not in your books.
            </p>
            <p className="text-gray-500">If that explains it, you can submit the statement. If not, go back and check the lines first.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" id="bankFinalizeCancel" className="px-4 py-2 rounded-lg border dark:border-gray-600 text-sm cursor-pointer" onClick={() => setConfirmDifference(null)}>Go back</button>
              <button type="button" id="bankFinalizeAnyway" className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-semibold text-sm cursor-pointer"
                onClick={() => { setConfirmDifference(null); void submitFinalize(); }}>
                Submit statement anyway
              </button>
            </div>
          </div>
        </Modal>
      )}

      {view === 'TABLE' && <div className="flex flex-wrap items-center gap-2">
        {([['REVIEW', `To review (${open})`], ['UNMATCHED', `Unmatched (${counts.UNMATCHED ?? 0})`], ['SUGGESTED', `Suggested (${counts.SUGGESTED ?? 0})`], ['MATCHED', `Matched (${counts.MATCHED ?? 0})`], ['IGNORED', `Ignored (${counts.IGNORED ?? 0})`], ['ALL', `All (${lines.length})`]] as Array<[Filter, string]>).map(([f, label]) => (
          <button key={f} type="button" data-filter={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer ${filter === f ? 'bg-purple-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>{label}</button>
        ))}
      </div>}
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-600 p-0.5 text-xs font-semibold" role="tablist" aria-label="View">
        <button type="button" id="bankViewTable" role="tab" aria-selected={view === 'TABLE'} onClick={() => setView('TABLE')} className={`px-3 py-1.5 rounded-md cursor-pointer ${view === 'TABLE' ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>Table</button>
        <button type="button" id="bankViewBook" role="tab" aria-selected={view === 'BOOK'} onClick={() => setView('BOOK')} className={`px-3 py-1.5 rounded-md cursor-pointer ${view === 'BOOK' ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>Side by side</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs" id="bankFilters">
        <input id="bankLineSearch" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search narration, reference, amount or date"
          className="p-2 border rounded-lg w-64 dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
        <select id="bankDirection" aria-label="Money in or out" value={direction} onChange={(e) => setDirection(e.target.value as 'ALL' | 'IN' | 'OUT')} className="p-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white">
          <option value="ALL">In and out</option><option value="IN">Money in (credit)</option><option value="OUT">Money out (debit)</option>
        </select>
        <select id="bankTypeFilter" aria-label="Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="p-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white">
          <option value="">All types</option>
          {typesPresent.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
        <label className="flex items-center gap-1 text-gray-500">From <input id="bankDateFrom" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="p-1.5 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" /></label>
        <label className="flex items-center gap-1 text-gray-500">To <input id="bankDateTo" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="p-1.5 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white" /></label>
        {(search || direction !== 'ALL' || typeFilter || dateFrom || dateTo) && (
          <button type="button" id="bankClearFilters" className="text-purple-700 font-semibold hover:underline cursor-pointer"
            onClick={() => { setSearch(''); setDirection('ALL'); setTypeFilter(''); setDateFrom(''); setDateTo(''); }}>Clear filters</button>
        )}
        <span className="ml-auto text-gray-500">{shown.length} of {lines.length} lines</span>
      </div>

      {view === 'BOOK' && <BankVsBook statementId={statementId} lines={lines} search={search} onChanged={() => void load()} onRecord={(l) => setPostFor(l)}
        lineFilter={(l) => passesFilters(l)} entryFilter={(e) => {
          const out = Number(e.debit) > 0 ? false : true;   // a debit on the BANK ledger is money in
          if (direction === 'IN' && out) return false;
          if (direction === 'OUT' && !out) return false;
          if (dateFrom && e.date < dateFrom) return false;
          if (dateTo && e.date > dateTo) return false;
          return true;
        }} />}

      {view === 'TABLE' && selectedLines.length > 0 && (
        <div id="bankBulkBar" className="flex flex-wrap items-center gap-3 px-4 py-2 rounded-lg bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-sm">
          <b>{selectedLines.length} selected</b>
          <button type="button" id="bankBulkIgnore" onClick={() => setIgnoreTargets(selectedLines)} className="px-3 py-1.5 rounded-lg bg-gray-800 text-white text-xs font-semibold hover:bg-gray-900 cursor-pointer dark:bg-gray-600">Ignore selected…</button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-gray-500 hover:underline cursor-pointer">Clear</button>
        </div>
      )}

      {view === 'TABLE' && <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800">
        <table className="min-w-full text-xs" id="bankLinesTable">
          <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300">
            <tr>
              <th className="px-3 py-2 w-8">
                <input type="checkbox" id="bankSelectAll" aria-label="Select all open lines shown" disabled={openShown.length === 0} checked={allShownSelected}
                  onChange={() => setSelected(allShownSelected ? new Set() : new Set(openShown.map((l) => l.id)))} />
              </th>
              {['Date', 'Description', 'Ref no.', 'Debit (out)', 'Credit (in)', 'Balance', 'Status', 'Type & what we found', 'Action'].map((h) => (
                <th key={h} className={`font-semibold px-3 py-2 whitespace-nowrap ${['Debit (out)', 'Credit (in)', 'Balance'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500">
                {lines.length > 0 && (search || direction !== 'ALL' || typeFilter || dateFrom || dateTo)
                  ? <>No lines match. <button type="button" className="text-purple-700 font-semibold hover:underline cursor-pointer"
                      onClick={() => { setSearch(''); setDirection('ALL'); setTypeFilter(''); setDateFrom(''); setDateTo(''); }}>Clear filters</button></>
                  : filter === 'REVIEW' ? 'Nothing left to review. ' : 'No lines.'}
              </td></tr>
            )}
            {shown.map((l) => (
              <Fragment key={l.id}>
                <tr data-line-status={l.status} className="border-t border-gray-100 dark:border-gray-700 align-top">
                  <td className="px-3 py-2">{isOpenLine(l) && <input type="checkbox" data-select={l.id} aria-label={`Select ${l.narration}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{l.txnDate}</td>
                  <td className="px-3 py-2 min-w-[14rem] max-w-md">
                    <button type="button" data-expand={l.id} aria-expanded={expanded === l.id} onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                      className="flex items-start gap-1 text-left cursor-pointer hover:text-purple-700" title="Show full details">
                      <span className="text-gray-400 shrink-0">{expanded === l.id ? '▾' : '▸'}</span>
                      <span className="whitespace-normal break-words" title={l.narration}>{l.narration || '—'}</span>
                    </button>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-500 whitespace-nowrap">{l.reference || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-red-600 dark:text-red-400">{isZero(l.debit) ? '' : inr(l.debit)}</td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-600 dark:text-emerald-400">{isZero(l.credit) ? '' : inr(l.credit)}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-600 dark:text-gray-300">{l.balance === null ? '' : inr(l.balance)}</td>
                  <td className="px-3 py-2"><Badge tone={statusTone(l.status)}>{l.status.toLowerCase()}</Badge></td>
                  <td className="px-3 py-2 max-w-sm">
                    <Finding line={l} label={typeLabel} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Actions line={l}
                      onAccept={() => void act(() => api.post(`/bank/lines/${l.id}/accept`, {}), 'Matched')}
                      onPost={() => setPostFor(l)} onMatch={() => setMatchFor(l)}
                      onIgnore={() => setIgnoreTargets([l])} onConfirmIgnore={() => confirmIgnore(l)}
                      onUnmatch={() => void act(() => api.post(`/bank/lines/${l.id}/unmatch`), 'Reopened')} />
                  </td>
                </tr>
                {expanded === l.id && <LineDetailRow line={l} label={typeLabel} />}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>}

      {postFor && <PostModal line={postFor} account={account} types={types} onAddType={() => { setPostFor(null); setAddingType(true); }} onClose={() => setPostFor(null)} onDone={() => { setPostFor(null); void load(); }} />}
      {addingType && <AddTypeModal account={account} types={types} onClose={() => setAddingType(false)} onDone={(msg) => { setAddingType(false); showToast(msg, 'success'); void load(); }} />}
      {matchFor && <MatchModal line={matchFor} onClose={() => setMatchFor(null)} onDone={() => { setMatchFor(null); void load(); }} />}
      {ignoreTargets && (
        <IgnoreModal targets={ignoreTargets} allLines={lines} statementId={statementId} onClose={() => setIgnoreTargets(null)}
          onDone={() => { setIgnoreTargets(null); setSelected(new Set()); void load(); }} />
      )}
    </div>
  );
}

/** One compact bar: bank balance, book balance, matched, outstanding and the difference. Workings sit behind a toggle. */
function SummaryBar({ statement, lines, s, open }: { statement: StatementRow; lines: Line[]; s: Summary; open: number }) {
  const [workings, setWorkings] = useState(false);
  const diff = s.summary.difference;
  const reconciled = open === 0 && s.summary.reconciled;
  const matched = lines.filter((l) => l.status === 'MATCHED');
  const openLinesList = lines.filter(isOpenLine);
  const amt = (l: Line) => Math.abs(Number(isZero(l.credit) ? l.debit : l.credit));
  const matchedTotal = matched.reduce((a, l) => a + amt(l), 0);
  const outstandingTotal = openLinesList.reduce((a, l) => a + amt(l), 0);
  const money = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : inr(v));
  const cell = 'flex-1 min-w-[8rem] px-3 py-2';
  const good = diff !== null && isZero(diff) && reconciled;
  return (
    <div id="bankStrip" className="sticky top-0 z-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-800/95 backdrop-blur shadow-sm">
      <div className="flex flex-wrap divide-x divide-gray-100 dark:divide-gray-700 text-xs">
        <div className={cell}><div className="text-gray-500">Bank statement balance</div><div id="bankStripBank" className="font-mono font-semibold">{money(statement.closingBalance)}</div></div>
        <div className={cell}><div className="text-gray-500">Book balance</div><div id="bankStripBook" className="font-mono font-semibold">{money(s.summary.bookBalance)}</div></div>
        <div className={cell}><div className="text-gray-500">Matched ({matched.length})</div><div id="bankStripMatched" className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{money(matchedTotal)}</div></div>
        <div className={cell}><div className="text-gray-500">Outstanding ({openLinesList.length})</div><div id="bankStripOutstanding" className="font-mono font-semibold text-amber-600 dark:text-amber-400">{money(outstandingTotal)}</div></div>
        <div className={`${cell} ${good ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
          <div className="opacity-80">Difference</div><div id="bankStripDifference" className="font-mono font-bold">{money(diff)}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs border-t border-gray-100 dark:border-gray-700">
        <span id="bankStripStatus" className={reconciled ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : 'text-amber-700 dark:text-amber-400'}>
          {reconciled ? '✓ Reconciled: books and bank agree' : open === 0 ? 'Every line is handled; check the difference above' : `${open} line${open === 1 ? '' : 's'} need attention`}
        </span>
        <button type="button" id="bankWorkingsToggle" aria-expanded={workings} onClick={() => setWorkings((w) => !w)} className="text-purple-700 dark:text-purple-300 font-semibold hover:underline cursor-pointer">
          {workings ? 'Hide' : 'How this is calculated'}
        </button>
      </div>
      {workings && <div className="p-3 border-t border-gray-100 dark:border-gray-700"><SummaryCard s={s} /></div>}
    </div>
  );
}

function LineDetailRow({ line, label }: { line: Line; label: (c: string | null | undefined) => string }) {
  const [d, setD] = useState<LineDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.get<LineDetail>(`/bank/lines/${line.id}/detail`).then((r) => { if (live) setD(r); }).catch((e) => { if (live) setErr(errorMessage(e)); });
    return () => { live = false; };
  }, [line.id, line.status]);
  const kv = (k: string, v: React.ReactNode) => (
    <div className="flex gap-2"><dt className="w-28 shrink-0 text-gray-500">{k}</dt><dd className="min-w-0 break-words">{v ?? '—'}</dd></div>
  );
  return (
    <tr data-detail={line.id} className="bg-gray-50 dark:bg-gray-900/40">
      <td />
      <td colSpan={9} className="px-3 py-3 text-xs">
        <div className="grid md:grid-cols-2 gap-x-8 gap-y-1">
          <dl className="space-y-1">
            {kv('Full narration', line.narration || '—')}
            {kv('Line no.', line.lineNo)}
            {kv('Transaction date', line.txnDate)}
            {kv('Value date', d?.valueDate ?? line.valueDate)}
            {kv('Reference', line.reference)}
            {kv('Import id', <span className="font-mono text-[10px]">{(d?.hash ?? line.hash)?.slice(0, 16)}</span>)}
          </dl>
          <dl className="space-y-1">
            {kv('Status', line.status.toLowerCase())}
            {line.category && kv('Type', label(line.category))}
            {!isZero(line.feeAmount) && kv('Fee gap', `${inr(line.feeAmount)} posted as a bank charge`)}
            {line.ignoreReason && kv('Ignored because', IGNORE_REASON_LABEL[line.ignoreReason])}
            {line.note && kv('Note', line.note)}
            {d?.resolvedAt && kv('Decided', `${d.resolvedBy ?? 'Someone'} on ${new Date(d.resolvedAt).toLocaleString('en-IN')}`)}
            {d?.voucherNumber && kv('Voucher posted', <span className="font-mono">{d.voucherNumber}</span>)}
          </dl>
        </div>
        {err && <div className="mt-2 text-red-600">{err}</div>}
        {!err && !d && <div className="mt-2 text-gray-400">Loading matched entries…</div>}
        {d && d.entries.length > 0 && (
          <div className="mt-3">
            <div className="font-semibold text-gray-600 dark:text-gray-300 mb-1">Matched book entries</div>
            <table className="min-w-full border border-gray-200 dark:border-gray-700 rounded">
              <tbody>
                {d.entries.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <td className="px-2 py-1 font-mono">{e.voucherNumber}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{e.date}</td>
                    <td className="px-2 py-1">{e.narration}</td>
                    <td className="px-2 py-1 text-gray-500">{e.sourceType ?? ''}</td>
                    <td className="px-2 py-1 text-right font-mono">{inr(Number(e.debit) > 0 ? e.debit : e.credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && d.entries.length === 0 && line.status === 'MATCHED' && <div className="mt-2 text-gray-500">No separate book entries: this line posted its own voucher.</div>}
      </td>
    </tr>
  );
}

function Finding({ line, label }: { line: Line; label: (c: string | null | undefined) => string }) {
  if (line.status === 'MATCHED') {
    return (
      <div>
        <div className="font-semibold text-gray-800 dark:text-gray-200">{label(line.category)}</div>
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
        {s?.kind === 'POST' ? `Post as ${(s.customTypeName ?? CATEGORY_LABEL[s.category]).toLowerCase()}` : 'Post to books…'}
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

function PostModal({ line, account, types, onAddType, onClose, onDone }: { line: Line; account: Account; types: TxnType[]; onAddType: () => void; onClose: () => void; onDone: () => void }) {
  const isIn = !isZero(line.credit);
  const options = isIn ? IN_CATEGORIES : OUT_CATEGORIES;
  const hinted = line.suggestion?.kind === 'POST' ? line.suggestion.category : null;
  const hintReason = line.suggestion?.kind === 'POST' ? line.suggestion.reason : null;
  const mine = types.filter((t) => t.isActive && (t.direction === 'EITHER' || t.direction === (isIn ? 'IN' : 'OUT')));
  const hintedType = line.suggestion?.kind === 'POST' ? line.suggestion.customTypeId : undefined;
  // `choice` is a built-in category id, or `type:<id>` for one of the customer's own types
  const [choice, setChoice] = useState<string>(hintedType && mine.some((t) => t.id === hintedType) ? `type:${hintedType}` : hinted && options.some((o) => o.id === hinted) ? hinted : options[0].id);
  // The customer's types may finish loading after the dialog opens: pick the suggested one then, unless they already chose
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (!picked && hintedType && mine.some((t) => t.id === hintedType)) setChoice(`type:${hintedType}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types, hintedType, picked]);
  const customId = choice.startsWith('type:') ? choice.slice(5) : null;
  const category = (customId ? '' : choice) as Category;
  const [ledgerId, setLedgerId] = useState('');
  const [ledgers, setLedgers] = useState<{ id: string; code: string; name: string }[]>([]);
  const [narration, setNarration] = useState('');
  const [busy, setBusy] = useState(false);
  const needsLedger = !customId && NEEDS_LEDGER.has(category);
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
      await api.post(`/bank/lines/${line.id}/post`, { ...(customId ? { typeId: customId } : { category }), ...(needsLedger ? { ledgerId } : {}), ...(narration.trim() ? { narration: narration.trim() } : {}) });
      showToast('Posted to your books and matched', 'success');
      onDone();
    } catch (err) { showToast(errorMessage(err), 'error'); setBusy(false); }
  };

  return (
    <Modal title={`Post ${inr(amount)} to your books`} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">“{line.narration}” is on the bank statement but not in your books yet. Choose what it is; a voucher is created and matched to this line.{hintReason && <span className="block text-xs text-gray-500 mt-1">{hintReason}</span>}</p>
      <div className="space-y-3">
        <Field label="What is it?">
          <select id="bankPostCategory" value={choice} onChange={(e) => { setPicked(true); setChoice(e.target.value); }} className="w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            {mine.length > 0 && <optgroup label="Your own types">{mine.map((t) => <option key={t.id} value={`type:${t.id}`}>{t.name}</option>)}</optgroup>}
          </select>
          <button type="button" id="bankPostAddType" onClick={onAddType} className="mt-1 text-xs text-purple-700 font-semibold hover:underline cursor-pointer">+ Add your own type</button>
        </Field>
        <p className="text-xs text-gray-500">{customId ? `Posts to “${types.find((t) => t.id === customId)?.ledgerName ?? ''}” and matches this line.` : options.find((o) => o.id === category)?.effect}</p>
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

/** A small form: name it, say which side it is on, pick the ledger it posts to, optionally say what text gives it away. */
type LedgerOption = { id: string; code: string; name: string; group: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE' };
const GROUP_LABEL: Record<LedgerOption['group'], string> = { EXPENSE: 'Expenses', INCOME: 'Income', ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Capital' };
const GROUP_ORDER: Array<LedgerOption['group']> = ['EXPENSE', 'INCOME', 'ASSET', 'LIABILITY', 'EQUITY'];
/** Which accounts make sense for a type by direction: no income for a payment, no expense for a receipt. */
function ledgersFor(direction: 'OUT' | 'IN' | 'EITHER', all: LedgerOption[]): LedgerOption[] {
  if (direction === 'OUT') return all.filter((l) => l.group !== 'INCOME');
  if (direction === 'IN') return all.filter((l) => l.group !== 'EXPENSE');
  return all;
}

function AddTypeModal({ account, types, onClose, onDone }: { account: Account; types: TxnType[]; onClose: () => void; onDone: (message: string) => void }) {
  const [name, setName] = useState('');
  const [direction, setDirection] = useState<'OUT' | 'IN' | 'EITHER'>('OUT');
  const [ledgerId, setLedgerId] = useState('');
  const [matchText, setMatchText] = useState('');
  const [ledgers, setLedgers] = useState<LedgerOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    api.get<{ ledgers: LedgerOption[] }>(`/accounting/ledgers/${account.branchId}`)
      .then((r) => setLedgers(r.ledgers.filter((l) => l.code !== 'BANK')))
      .catch((err) => showToast(errorMessage(err), 'error'));
  }, [account.branchId]);

  // Money out is spent on expenses (or pays down a liability, or is drawn by the owner); money in is income, a loan or capital
  const offered = ledgersFor(direction, ledgers);
  useEffect(() => { if (ledgerId && !offered.some((l) => l.id === ledgerId)) setLedgerId(''); }, [direction]);  // eslint-disable-line react-hooks/exhaustive-deps

  const n = name.trim();
  const errors = {
    name: n.length < 3 ? 'Use at least 3 characters' : n.length > 40 ? 'Use at most 40 characters'
      : types.some((t) => t.name.toLowerCase() === n.toLowerCase()) ? `A type named “${n}” already exists` : '',
    ledger: ledgerId ? '' : 'Choose the account it posts to',
    text: matchText.trim() && matchText.trim().length < 3 ? 'Use at least 3 characters' : '',
  };
  const invalid = Boolean(errors.name || errors.ledger || errors.text);

  const save = async (applyToOpen: boolean) => {
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setServerError(null);
    try {
      const r = await api.post<{ applied: number }>(`/bank/accounts/${account.id}/types`, {
        name: n, direction, ledgerId, ...(matchText.trim() ? { matchText: matchText.trim() } : {}), applyToOpen,
      });
      onDone(applyToOpen && r.applied > 0 ? `“${n}” saved and offered on ${r.applied} line${r.applied === 1 ? '' : 's'}` : `“${n}” saved`);
    } catch (err) { setServerError(errorMessage(err)); setBusy(false); }
  };

  const input = 'w-full p-2 border rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white';
  const err = (m: string) => (touched && m ? <div className="text-xs text-red-600 mt-0.5">{m}</div> : null);
  return (
    <Modal title="Add a transaction type" onClose={onClose}>
      <div className="space-y-3" id="bankTypeForm">
        <p className="text-sm text-gray-600 dark:text-gray-300">For money that is not in the list (rent, loan EMI, a regular customer…). Once saved it appears under “Your own types” when you post a line.</p>
        <Field label="Name">
          <input id="bankTypeName" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Hotel rent" className={input} />
          {err(errors.name)}
        </Field>
        <Field label="It appears as">
          <select id="bankTypeDirection" value={direction} onChange={(e) => setDirection(e.target.value as 'OUT' | 'IN' | 'EITHER')} className={input}>
            <option value="OUT">Money out (a debit on the statement)</option>
            <option value="IN">Money in (a credit on the statement)</option>
            <option value="EITHER">Either</option>
          </select>
        </Field>
        <Field label="Posts to this account">
          <select id="bankTypeLedger" value={ledgerId} onChange={(e) => setLedgerId(e.target.value)} className={input}>
            <option value="">Choose an account…</option>
            {GROUP_ORDER.map((g) => {
              const list = offered.filter((l) => l.group === g);
              return list.length ? <optgroup key={g} label={GROUP_LABEL[g]}>{list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup> : null;
            })}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">{direction === 'OUT' ? 'Money out: pick what it was spent on.' : direction === 'IN' ? 'Money in: pick where it came from.' : 'Either way: every account is listed.'}</p>
          {err(errors.ledger)}
        </Field>
        <Field label="Suggest it when the narration contains (optional)">
          <input id="bankTypeText" value={matchText} onChange={(e) => setMatchText(e.target.value)} maxLength={80} placeholder="e.g. HOTEL RENT" className={input} />
          {err(errors.text)}
        </Field>
        {serverError && <div id="bankTypeError" className="p-2 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">{serverError}</div>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border dark:border-gray-600 cursor-pointer">Cancel</button>
          {matchText.trim().length >= 3 && (
            <button type="button" id="bankTypeSaveApply" disabled={busy} onClick={() => void save(true)}
              className="px-4 py-2 text-sm rounded-lg border border-purple-400 text-purple-700 font-semibold hover:bg-purple-50 disabled:opacity-50 cursor-pointer">Save and apply to waiting lines</button>
          )}
          <button type="button" id="bankTypeSave" disabled={busy} onClick={() => void save(false)}
            className="px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-semibold hover:bg-purple-700 disabled:opacity-50 cursor-pointer">Save</button>
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
