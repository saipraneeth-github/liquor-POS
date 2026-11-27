import { useState } from 'react';
import { inr } from '../components/ui';
import { useT } from '../i18n';
import { isZero, type Line } from './types';

export function SimpleReview({ lines, remaining, onMatch, onRecord, onIgnore, onReload }: {
  lines: Line[]; remaining: number;
  onMatch: (line: Line) => void; onRecord: (line: Line) => void; onIgnore: (line: Line) => void;
  onReload: () => void;
}) {
  const { t } = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pending = lines.filter((line) => line.status === 'UNMATCHED' || line.status === 'SUGGESTED');
  const line = pending.find((entry) => entry.id === selectedId) ?? pending[0];
  const index = line ? pending.indexOf(line) : 0;
  const next = () => setSelectedId(pending[(index + 1) % pending.length]?.id ?? null);
  const previous = () => setSelectedId(pending[(index - 1 + pending.length) % pending.length]?.id ?? null);
  if (!line) return (
    <div className="py-8 space-y-3" role="status">
      <h2 className="text-xl font-bold">{t(remaining === 0 ? 'Every transaction has been checked' : 'More transactions need checking')}</h2>
      <p className="text-gray-600 dark:text-gray-300">{t(remaining === 0 ? 'Check the balances below, then finish.' : 'Open All entries & tools to find the remaining transactions.')}</p>
      {remaining > 0 && <button type="button" onClick={onReload} className="border rounded-lg px-4 py-2">{t('Refresh')}</button>}
    </div>
  );
  const incoming = !isZero(line.credit);
  return (
    <section aria-label={t('Review one by one')} className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 lg:gap-10 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <h2 className="font-semibold">{t('To check')} <span className="tabular-nums">({remaining})</span></h2>
          <span aria-live="polite" className="text-xs text-gray-500 tabular-nums">{index + 1} / {pending.length}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <button id="bankPreviousTransaction" type="button" disabled={pending.length < 2} onClick={previous}
            className="min-h-14 rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-purple-600 disabled:opacity-40 disabled:cursor-not-allowed"><span aria-hidden="true">← </span>{t('Previous')}</button>
          <button id="bankNextTransaction" type="button" disabled={pending.length < 2} onClick={next}
            className="min-h-14 rounded-lg bg-purple-600 px-4 py-3 text-sm font-semibold text-white hover:bg-purple-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600 disabled:opacity-40 disabled:cursor-not-allowed">{t('Next')}<span aria-hidden="true"> →</span></button>
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 sm:p-6">
          <div className="flex flex-wrap justify-between gap-2 text-sm text-gray-600 dark:text-gray-300"><span>{line.txnDate}</span><strong className={incoming ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}>{t(incoming ? 'Money received' : 'Money paid')}</strong></div>
          <div id="bankReviewAmount" className={`font-display text-3xl sm:text-4xl font-bold my-5 break-words tabular-nums ${incoming ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}><span aria-hidden="true">{incoming ? '+' : '−'} </span>{inr(incoming ? line.credit : line.debit)}</div>
          <p id="bankReviewDescription" className="text-base leading-relaxed break-words">{line.narration || '—'}</p>
          {line.reference && <p className="mt-3 text-sm text-gray-600 dark:text-gray-300 break-all">{t('Reference')}: {line.reference}</p>}
          {line.suggestion && <p className="mt-5 pt-4 border-t border-gray-200 dark:border-gray-700 text-sm text-purple-800 dark:text-purple-200">
            {t(line.suggestion.kind === 'ONE_TO_ONE' || line.suggestion.kind === 'SETTLEMENT' ? 'A possible match was found. Check it before confirming.' : line.suggestion.kind === 'IGNORE' ? 'A rule suggests this is not a shop transaction. Check before leaving it out.' : 'This may need a new entry in your books. Check before recording it.')}
          </p>}
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-3">{t('Not sure? Move to the next transaction. This one stays to check.')}</p>
      </div>
      <div className="min-w-0">
        <h2 className="text-xl font-bold mb-4">{t('What is this transaction?')}</h2>
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{t('A match links this bank line to an entry already recorded. It does not create another payment.')}</p>
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {[
            { id: 'bankSimpleMatch', title: 'Already in our books', help: 'Find the sale, payment or other entry that matches.', action: onMatch },
            { id: 'bankSimpleRecord', title: 'Missing from our books', help: 'Record a bank fee, deposit, expense or other payment.', action: onRecord },
            { id: 'bankSimpleIgnore', title: 'Not for this shop', help: 'Choose a reason. It stays on the statement.', action: onIgnore },
          ].map((choice) => <button key={choice.id} id={choice.id} type="button" onClick={() => choice.action(line)}
            className="w-full text-left py-5 px-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-purple-600">
            <span className="block font-semibold text-purple-800 dark:text-purple-200">{t(choice.title)}</span>
            <span className="block text-sm mt-1 text-gray-600 dark:text-gray-300">{t(choice.help)}</span>
          </button>)}
        </div>
      </div>
    </section>
  );
}
