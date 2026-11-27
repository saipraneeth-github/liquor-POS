import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../i18n';
import { businessDate } from '../lib/business-day';

type Entry = { voucherId: string; voucherNumber: string; voucherType: string; narration: string; debit: string; credit: string; balance: string };
type Day = { date: string; opening: string; receipts: string; payments: string; closing: string; entries: Entry[] };
type Book = { ledger: { code: string; name: string }; opening: string; closing: string; totalReceipts: string; totalPayments: string; days: Day[] };

const money = (v: string) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

/** The classic cash book (or bank book): each day opens with a balance, takes receipts, pays out, and closes. */
export function CashBook({ branchId }: { branchId: string }) {
  const { t } = useT();
  const [error, setError] = useState(false);
  const [ledger, setLedger] = useState<'CASH' | 'BANK'>('CASH');
  const [from, setFrom] = useState(businessDate(-30));
  const [to, setTo] = useState(businessDate());
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError(false);
    try {
      setBook(await api.get<Book>(`/accounting/cash-book/${branchId}?ledger=${ledger}&from=${from}&to=${to}`));
    } catch {
      setError(true);
      setBook(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, ledger, from, to]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div id="cashBook" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Book
          <select id="cbLedger" className="input-base mt-1" value={ledger} onChange={(e) => setLedger(e.target.value as 'CASH' | 'BANK')}>
            <option value="CASH">Cash book</option>
            <option value="BANK">Bank book</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">From
          <input id="cbFrom" type="date" className="input-base mt-1" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">To
          <input id="cbTo" type="date" className="input-base mt-1" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {loading && <div role="status" className="text-sm text-gray-500">{t('Loading report…')}</div>}
      {error && <div role="alert" className="rounded-lg border p-4"><p>{t('Could not load this report. Try again.')}</p><button type="button" onClick={() => void load()} className="underline">{t('Try again')}</button></div>}

      {book && !loading && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 text-sm">
            {[['Opening balance', book.opening], ['Money received', book.totalReceipts], ['Money paid', book.totalPayments], ['Closing balance', book.closing]].map(([label, v]) => (
              <div key={label} className={`p-5 rounded-xl border dark:border-gray-700 ${label === 'Closing balance' ? 'bg-purple-50 dark:bg-purple-950/30 border-purple-200' : 'bg-white dark:bg-gray-800'}`}>
                <div className="text-sm text-gray-500">{t(label)}</div>
                <div className="mt-3 font-display font-bold text-xl tabular-nums break-words">{money(v)}</div>
              </div>
            ))}
          </div>

          {book.days.length === 0 && <div className="p-6 text-center text-sm text-gray-500 border rounded-lg dark:border-gray-700">No entries in this period.</div>}

          {book.days.map((d) => (
            <div key={d.date} className="border rounded-lg dark:border-gray-700 overflow-hidden bg-white dark:bg-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-750 text-xs">
                <span className="font-bold text-sm">{dayLabel(d.date)}</span>
                <span className="font-mono">Opening {money(d.opening)} · In {money(d.receipts)} · Out {money(d.payments)} · <b>Closing {money(d.closing)}</b></span>
              </div>
              <div className="overflow-x-auto">
                <table className="accounting-stack-table w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500">
                      <th className="px-3 py-1.5">Voucher</th><th className="px-3 py-1.5">Particulars</th>
                      <th className="px-3 py-1.5 text-right">Receipt</th><th className="px-3 py-1.5 text-right">Payment</th><th className="px-3 py-1.5 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.entries.map((e) => (
                      <tr key={e.voucherId + e.debit + e.credit} className="border-t dark:border-gray-700">
                        <td data-label={t('Voucher')} className="px-3 py-3 font-mono whitespace-nowrap">{e.voucherNumber}</td>
                        <td data-label={t('Description')} className="px-3 py-3">{e.narration}</td>
                        <td data-label={t('Money received')} className="px-3 py-3 text-right font-mono">{Number(e.debit) ? money(e.debit) : '—'}</td>
                        <td data-label={t('Money paid')} className="px-3 py-3 text-right font-mono">{Number(e.credit) ? money(e.credit) : '—'}</td>
                        <td data-label={t('Balance')} className="px-3 py-3 text-right font-mono">{money(e.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
