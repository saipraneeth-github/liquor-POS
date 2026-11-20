import { useEffect, useState } from 'react';
import { Modal } from '../components/ui';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';

type Line = { id: string; productName?: string | null; servingLabel?: string | null; quantity: number; lineTotal: string };
type BillForReturn = { id: string; billNumber: string; paymentMode: string; subtotal: string; discount: string; items?: Line[] };

const money = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A customer brings bottles back from a paid bill. Refunds go back the way the bill was paid (cash, UPI / card, or off the
 * khata balance); pegs and glasses cannot be returned. The figure shown is an estimate: the server works out the exact
 * amount to the paisa and the share of the bill discount.
 */
export function ReturnDialog({ bill, onClose, onDone }: { bill: BillForReturn; onClose: () => void; onDone: () => void }) {
  const [fetchedBill, setFetchedBill] = useState<BillForReturn | null>(null);
  const [loading, setLoading] = useState<boolean>(!bill.items || bill.items.length === 0);
  const [returned, setReturned] = useState<Record<string, number>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    api.get<{ returnedByItem: Record<string, number> }>(`/bills/${bill.id}/returns`)
      .then((r) => { if (active) setReturned(r.returnedByItem ?? {}); })
      .catch(() => { if (active) setReturned({}); });

    if (!bill.items || bill.items.length === 0) {
      setLoading(true);
      api.get<BillForReturn>(`/bills/${bill.id}`)
        .then((b) => {
          if (active) setFetchedBill(b);
        })
        .catch((err) => {
          if (active) setError(errorMessage(err));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setLoading(false);
    }

    return () => { active = false; };
  }, [bill.id, bill.items]);

  // Always prefer whichever object has items
  const currentBill = (bill.items && bill.items.length > 0)
    ? bill
    : (fetchedBill ?? bill);

  const items = currentBill.items ?? [];
  const subtotal = Number(currentBill.subtotal || 0);
  const discount = Number(currentBill.discount || 0);
  const paidShare = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  const left = (l: Line) => l.quantity - (returned[l.id] ?? 0);
  const chosen = items.filter((l) => Number(qty[l.id]) > 0);
  const estimate = chosen.reduce((n, l) => n + (Number(l.lineTotal) * Number(qty[l.id])) / l.quantity * paidShare, 0);

  const how = currentBill.paymentMode === 'CREDIT' ? "taken off the customer's khata balance" : currentBill.paymentMode === 'CASH' ? 'given back in cash' : `refunded to the customer by ${currentBill.paymentMode}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await api.post<{ refundAmount: string; returnNumber: string }>(`/bills/${currentBill.id}/returns`, {
        reason: reason.trim(), items: chosen.map((l) => ({ billItemId: l.id, quantity: Number(qty[l.id]) })),
      });
      showToast(`Return ${res.returnNumber}: ${money(Number(res.refundAmount))} ${how}`, 'success');
      onDone(); onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  };

  return (
    <Modal title={`Return from bill ${currentBill.billNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-gray-600 dark:text-gray-300">Bottles go back into stock. The refund is {how}.</p>
        {error && <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 text-red-800 text-xs rounded-lg">{error}</div>}
        {loading ? (
          <div className="p-6 text-center text-xs text-gray-500">Loading bill items…</div>
        ) : items.length === 0 ? (
          <div className="p-4 text-center text-xs text-gray-500">No returnable items on this bill.</div>
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1">Item</th><th className="text-right">Sold</th><th className="text-right">Can return</th><th className="text-right">Return</th></tr></thead>
            <tbody>
              {items.map((l) => {
                const peg = !!l.servingLabel;
                const can = peg ? 0 : left(l);
                return (
                  <tr key={l.id} className="border-t dark:border-gray-700">
                    <td className="py-1.5">{l.productName}{peg && <span className="text-gray-500"> · {l.servingLabel} (cannot be returned)</span>}</td>
                    <td className="text-right font-mono">{l.quantity}</td>
                    <td className="text-right font-mono">{can}</td>
                    <td className="text-right">
                      <input className="input-base w-16 text-right font-mono" inputMode="numeric" disabled={can === 0} aria-label={`Return ${l.productName}`}
                        value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: String(Math.min(can, Number(e.target.value.replace(/\D/g, '') || 0)) || '') })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <label className="block text-xs font-semibold">Reason
          <input id="retReason" className="input-base w-full mt-1" required minLength={5} maxLength={300} placeholder="e.g. sealed bottle, customer changed mind" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="flex items-center justify-between">
          <span className="text-sm">Refund about <b className="font-mono">{money(estimate)}</b></span>
          <div className="flex gap-3">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg" onClick={onClose}>Cancel</button>
            <button id="retSave" type="submit" disabled={saving || loading || chosen.length === 0} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-60">Record return</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
