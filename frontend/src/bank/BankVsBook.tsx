import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Badge, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { isZero, type Line } from './types';

export type BookEntry = {
  id: string;
  date: string;
  debit: string;
  credit: string;
  narration: string;
  sourceType: string | null;
  voucherNumber: string;
  matchedLineId: string | null;
};

const isOpen = (l: Line) => l.status === 'UNMATCHED' || l.status === 'SUGGESTED';
const lineIsIn = (l: Line) => !isZero(l.credit);
const lineAmount = (l: Line) => Number(lineIsIn(l) ? l.credit : l.debit);
/** What an entry is worth towards a line: money in for a credit line is a debit to the BANK ledger, money out is a credit. */
const entryValue = (e: BookEntry, lineIn: boolean) => (lineIn ? Number(e.debit) - Number(e.credit) : Number(e.credit) - Number(e.debit));
const entryAmount = (e: BookEntry) => Number(e.debit) > 0 ? Number(e.debit) : Number(e.credit);
const entryIsIn = (e: BookEntry) => Number(e.debit) > 0;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The statement beside the books. Matched pairs are lined up in rows; below them the bank lines and the book
 * entries that still have no partner. Pick one bank line and the entries it pays for (or drag the line onto an
 * entry), then Match. A settlement can cover many sales; if the bank kept a fee, it can be posted as a bank charge.
 */
export function BankVsBook({ statementId, lines, search, onChanged, onRecord, lineFilter, entryFilter }: { statementId: string; lines: Line[]; search: string; onChanged: () => void; onRecord?: (l: Line) => void; lineFilter?: (l: Line) => boolean; entryFilter?: (e: BookEntry) => boolean }) {
  const [book, setBook] = useState<BookEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickedLine, setPickedLine] = useState<string | null>(null);
  const [pickedEntries, setPickedEntries] = useState<Set<string>>(new Set());
  const [postDiff, setPostDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'matched' | 'bank' | 'book'>('bank');
  const [dragOver, setDragOver] = useState<string | null>(null);

  // `lines` is a new array after every change, so this refreshes the book side too
  useEffect(() => {
    let live = true;
    setError(null);
    api.get<BookEntry[]>(`/bank/statements/${statementId}/book`)
      .then((b) => { if (live) setBook(b); })
      .catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [statementId, lines]);

  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearch = (hay: string) => words.every((w) => hay.toLowerCase().includes(w));

  const lineIds = useMemo(() => new Set(lines.map((l) => l.id)), [lines]);
  const entriesByLine = useMemo(() => {
    const m = new Map<string, BookEntry[]>();
    for (const e of book ?? []) if (e.matchedLineId) m.set(e.matchedLineId, [...(m.get(e.matchedLineId) ?? []), e]);
    return m;
  }, [book]);

  const passLine = (l: Line) => !lineFilter || lineFilter(l);
  const passEntry = (e: BookEntry) => !entryFilter || entryFilter(e);
  const pairs = lines.filter((l) => l.status === 'MATCHED' && passLine(l) && matchesSearch(`${l.narration} ${l.reference ?? ''} ${l.credit} ${l.debit}`));
  const openLines = lines.filter((l) => isOpen(l) && passLine(l) && matchesSearch(`${l.narration} ${l.reference ?? ''} ${l.txnDate} ${Number(l.credit)} ${Number(l.debit)}`));
  const openEntries = (book ?? []).filter((e) => !e.matchedLineId && passEntry(e) && matchesSearch(`${e.narration} ${e.date} ${e.voucherNumber} ${entryAmount(e)}`));
  const ignoredCount = lines.filter((l) => l.status === 'IGNORED').length;
  // an entry matched to a line of another statement is accounted for, just not here
  const elsewhere = (book ?? []).filter((e) => e.matchedLineId && !lineIds.has(e.matchedLineId)).length;

  const line = lines.find((l) => l.id === pickedLine) ?? null;
  const lineIn = line ? lineIsIn(line) : true;
  const chosen = (book ?? []).filter((e) => pickedEntries.has(e.id));
  const total = round2(chosen.reduce((a, e) => a + entryValue(e, lineIn), 0));
  // > 0: the bank kept (receipt) or took (payment) this much beyond the entries; < 0: the statement shows more than they cover
  const fee = line ? round2(lineIn ? total - lineAmount(line) : lineAmount(line) - total) : 0;
  const canMatch = !!line && chosen.length > 0 && fee >= -0.005 && (Math.abs(fee) < 0.005 || postDiff);

  const pickLine = (id: string) => {
    if (pickedLine === id) { setPickedLine(null); setPickedEntries(new Set()); setPostDiff(false); return; }
    setPickedLine(id); setPickedEntries(new Set()); setPostDiff(false);
  };
  const toggleEntry = (id: string) => {
    if (!pickedLine) { showToast('Pick a bank line first', 'info'); return; }
    setPickedEntries((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const doMatch = async () => {
    if (!line || !canMatch) return;
    setBusy(true);
    try {
      await api.post(`/bank/lines/${line.id}/match`, { entryIds: [...pickedEntries], postDifference: postDiff });
      showToast('Matched', 'success');
      setPickedLine(null); setPickedEntries(new Set()); setPostDiff(false);
      onChanged();
    } catch (e) { showToast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  const unmatch = async (l: Line) => {
    try { await api.post(`/bank/lines/${l.id}/unmatch`); showToast('Reopened', 'success'); onChanged(); } catch (e) { showToast(errorMessage(e), 'error'); }
  };

  if (error) return <div id="bvbError" className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>;
  if (book === null) return <div id="bvbLoading" className="text-sm text-gray-500">Loading the books…</div>;

  const bankCard = (l: Line) => {
    const picked = pickedLine === l.id;
    return (
      <div key={l.id} data-bvb-line={l.id} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; }}
        onClick={() => pickLine(l.id)} role="button" tabIndex={0} aria-pressed={picked}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickLine(l.id); } }}
        className={`p-2.5 rounded-lg border text-xs cursor-pointer select-none ${picked ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/30 ring-1 ring-purple-400' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-purple-300'}`}>
        <div className="flex justify-between gap-2">
          <span className="text-gray-500 whitespace-nowrap">{l.txnDate}</span>
          <span className={`font-mono font-semibold ${lineIsIn(l) ? 'text-emerald-600' : 'text-red-600'}`}>{lineIsIn(l) ? '+' : '−'}{inr(lineAmount(l))}</span>
        </div>
        <div className="mt-0.5 break-words">{l.narration || '—'}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-400">
          {l.reference && <span className="font-mono">{l.reference}</span>}
          <Badge tone={l.status === 'SUGGESTED' ? 'info' : 'warn'}>{l.status.toLowerCase()}</Badge>
          {onRecord && <button type="button" data-bvb-record={l.id} onClick={(e) => { e.stopPropagation(); onRecord(l); }} className="ml-auto px-2 py-0.5 rounded border border-purple-300 text-purple-700 dark:text-purple-300 font-semibold hover:bg-purple-50 dark:hover:bg-purple-950/30 cursor-pointer">Record…</button>}
        </div>
      </div>
    );
  };

  const entryCard = (e: BookEntry) => {
    const picked = pickedEntries.has(e.id);
    // dim what cannot be the other half of the picked line (a credit line needs money in the books, and the reverse)
    const fits = !line || entryIsIn(e) === lineIn;
    return (
      <div key={e.id} data-bvb-entry={e.id} role="button" tabIndex={0} aria-pressed={picked} onClick={() => toggleEntry(e.id)}
        onKeyDown={(k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); toggleEntry(e.id); } }}
        onDragOver={(ev) => { ev.preventDefault(); setDragOver(e.id); }} onDragLeave={() => setDragOver(null)}
        onDrop={(ev) => { ev.preventDefault(); setDragOver(null); const id = ev.dataTransfer.getData('text/plain'); if (id) { setPickedLine(id); setPickedEntries(new Set([e.id])); setPostDiff(false); } }}
        className={`p-2.5 rounded-lg border text-xs cursor-pointer select-none ${dragOver === e.id ? 'border-purple-500 bg-purple-100 dark:bg-purple-950/40' : picked ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/30 ring-1 ring-purple-400' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-purple-300'} ${fits ? '' : 'opacity-40'}`}>
        <div className="flex justify-between gap-2">
          <span className="text-gray-500 whitespace-nowrap">{e.date}</span>
          <span className={`font-mono font-semibold ${entryIsIn(e) ? 'text-emerald-600' : 'text-red-600'}`}>{entryIsIn(e) ? '+' : '−'}{inr(entryAmount(e))}</span>
        </div>
        <div className="mt-0.5 break-words">{e.narration}</div>
        <div className="mt-1 text-[10px] text-gray-400"><span className="font-mono">{e.voucherNumber}</span>{e.sourceType ? ` · ${e.sourceType.toLowerCase().replace(/_/g, ' ')}` : ''}</div>
      </div>
    );
  };

  const col = (which: 'matched' | 'bank' | 'book') => `${tab === which ? 'block' : 'hidden'} md:block`;

  return (
    <div id="bankVsBook" className="space-y-4">
      {/* On a phone the two sides are tabs */}
      <div className="md:hidden inline-flex rounded-lg border border-gray-200 dark:border-gray-600 p-0.5 text-xs font-semibold">
        <button type="button" id="bvbTabMatched" onClick={() => setTab('matched')} className={`px-3 py-1.5 rounded-md cursor-pointer ${tab === 'matched' ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>Matched ({pairs.length})</button>
        <button type="button" id="bvbTabBank" onClick={() => setTab('bank')} className={`px-3 py-1.5 rounded-md cursor-pointer ${tab === 'bank' ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>Bank ({openLines.length})</button>
        <button type="button" id="bvbTabBook" onClick={() => setTab('book')} className={`px-3 py-1.5 rounded-md cursor-pointer ${tab === 'book' ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>Books ({openEntries.length})</button>
      </div>

      {line && (
        <div id="bvbMatchBar" className="sticky top-14 z-10 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 rounded-lg bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-sm shadow-sm">
          <span>Bank line <b className="font-mono">{inr(lineAmount(line))}</b></span>
          <span>Selected entries <b className="font-mono" id="bvbTotal">{inr(total)}</b> ({chosen.length})</span>
          {chosen.length > 0 && Math.abs(fee) >= 0.005 && (
            fee > 0
              ? <label className="flex items-center gap-2 text-amber-700 dark:text-amber-300"><input id="bvbPostDiff" type="checkbox" checked={postDiff} onChange={(e) => setPostDiff(e.target.checked)} />The bank kept {inr(fee)}: post it as a bank charge</label>
              : <span id="bvbShort" className="text-red-600 dark:text-red-400">The statement shows {inr(-fee)} more than these entries. Pick more, or post that part separately.</span>
          )}
          {chosen.length > 0 && Math.abs(fee) < 0.005 && <span className="text-emerald-700 dark:text-emerald-400">✓ Amounts agree</span>}
          <span className="ml-auto flex gap-2">
            <button type="button" id="bvbClear" onClick={() => { setPickedLine(null); setPickedEntries(new Set()); setPostDiff(false); }} className="px-3 py-1.5 text-xs rounded-lg border dark:border-gray-600 cursor-pointer">Clear</button>
            <button type="button" id="bvbMatch" disabled={!canMatch || busy} onClick={() => void doMatch()} className="px-4 py-1.5 text-xs rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-40 cursor-pointer">Match</button>
          </span>
        </div>
      )}

        <div className="grid md:grid-cols-3 gap-4 items-start">
          <div className={col('matched')} id="bvbPairs">
            <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 mb-1.5">Matched ({pairs.length})</div>
            <div className="space-y-2">
              {pairs.length === 0 && <div className="p-3 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500">Nothing matched yet.</div>}
              {pairs.map((l) => {
                const entries = entriesByLine.get(l.id) ?? [];
                return (
                  <div key={l.id} data-bvb-pair={l.id} className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 text-xs p-2.5 space-y-1">
                    <div className="flex justify-between gap-2"><span className="text-gray-500">{l.txnDate}</span><span className={`font-mono font-semibold ${lineIsIn(l) ? 'text-emerald-600' : 'text-red-600'}`}>{lineIsIn(l) ? '+' : '−'}{inr(lineAmount(l))}</span></div>
                    <div className="break-words">{l.narration || '—'}</div>
                    <div className="pt-1 border-t border-emerald-200/70 dark:border-emerald-900 text-[11px] text-gray-500">
                      {entries.length > 0 ? entries.map((e) => <div key={e.id} className="break-words">↔ {e.narration} <span className="font-mono">{e.voucherNumber}</span></div>) : <div>↔ {l.voucherId ? 'posted its own voucher' : 'matched'}</div>}
                      {!isZero(l.feeAmount) && <div>+ {inr(l.feeAmount)} bank charge posted</div>}
                      {l.voucherId ? <span className="text-gray-400">posted</span> : <button type="button" data-bvb-unmatch={l.id} onClick={() => void unmatch(l)} className="text-gray-500 hover:underline cursor-pointer">Unmatch</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className={col('bank')}>
            <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">Unmatched bank lines ({openLines.length})</div>
            <div className="space-y-2" id="bvbBankList">
              {openLines.length === 0 && <div className="p-3 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500">{lines.some(isOpen) ? 'No lines match your search.' : 'Every bank line is handled.'}</div>}
              {openLines.map(bankCard)}
            </div>
          </div>
          <div className={col('book')}>
            <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">Unmatched book entries ({openEntries.length})</div>
            <div className="space-y-2" id="bvbBookList">
              {openEntries.length === 0 && <div className="p-3 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500">No book entries waiting for the bank.</div>}
              {openEntries.map(entryCard)}
            </div>
          </div>
        </div>

      <p className="text-[11px] text-gray-400">
        Pick a bank line, then the book entries it pays for, then Match. Or drag a bank line onto an entry.
        {ignoredCount > 0 && ` ${ignoredCount} ignored line${ignoredCount === 1 ? ' is' : 's are'} left out of this view.`}
        {elsewhere > 0 && ` ${elsewhere} book entr${elsewhere === 1 ? 'y is' : 'ies are'} already matched on another statement.`}
      </p>
    </div>
  );
}
