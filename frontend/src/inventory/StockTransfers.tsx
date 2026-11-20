import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/ui';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';

type StockRow = { productId: string; name: string; quantity: number };
type Line = { productId: string; name: string; quantity: number; receivedQuantity: number | null };
type Transfer = {
  id: string; transferNumber: string; status: 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED'; fromBranchId: string; toBranchId: string;
  fromBranchName: string; toBranchName: string; note: string | null; createdAt: string; createdByName: string; totalBottles: number; shortage: number;
  cancelReason: string | null; items: Line[];
};
type Outlet = { id: string; name: string; code: string };

const STATUS_STYLE: Record<Transfer['status'], string> = {
  IN_TRANSIT: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  RECEIVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  CANCELLED: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

/** Stock sent to / received from the other outlets of the business. Bottles leave the sender at dispatch and arrive when confirmed. */
export function StockTransfers({ branchId, stockRows, onChanged }: { branchId: string; stockRows: StockRow[]; onChanged: () => void }) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [receiving, setReceiving] = useState<Transfer | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, o] = await Promise.all([
        api.get<{ transfers: Transfer[] }>(`/transfers?branchId=${branchId}`),
        api.get<{ branches: Outlet[] }>(`/transfers/destinations?branchId=${branchId}`),
      ]);
      setTransfers(t.transfers);
      setOutlets(o.branches);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const cancel = async (t: Transfer) => {
    const reason = window.prompt(`Cancel ${t.transferNumber}? The bottles go back to your stock. Why?`);
    if (!reason) return;
    try {
      await api.post(`/transfers/${t.id}/cancel`, { reason });
      showToast('Transfer cancelled, bottles returned to stock', 'success');
      await load(); onChanged();
    } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  return (
    <div id="stockTransfers" className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-display font-bold text-gray-900 dark:text-gray-100">Transfers between outlets</h3>
          <p className="text-xs text-gray-500">Bottles leave the sender when sent and reach the other outlet when it confirms receipt.</p>
        </div>
        <button id="newTransferBtn" type="button" disabled={outlets.length === 0} title={outlets.length === 0 ? 'This business has no other outlet' : ''}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50" onClick={() => setShowNew(true)}>
          Send stock
        </button>
      </div>

      {transfers.length === 0 ? <div className="text-xs text-gray-500 py-4 text-center">No transfers yet.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1.5 pr-3">No.</th><th className="pr-3">From → To</th><th className="pr-3">Bottles</th><th className="pr-3">Status</th><th /></tr></thead>
            <tbody>
              {transfers.map((t) => {
                const incoming = t.toBranchId === branchId;
                return (
                  <tr key={t.id} className="border-t dark:border-gray-700 align-top">
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">{t.transferNumber}<div className="text-[10px] text-gray-400">{new Date(t.createdAt).toLocaleDateString('en-IN')}</div></td>
                    <td className="pr-3">{t.fromBranchName} → {t.toBranchName}
                      <div className="text-[10px] text-gray-500">{t.items.map((i) => `${i.name} × ${i.quantity}${i.receivedQuantity !== null && i.receivedQuantity !== i.quantity ? ` (got ${i.receivedQuantity})` : ''}`).join(', ')}</div>
                      {t.cancelReason && <div className="text-[10px] text-gray-500">Cancelled: {t.cancelReason}</div>}
                    </td>
                    <td className="pr-3 font-mono">{t.totalBottles}{t.shortage > 0 && <span className="text-red-600"> (−{t.shortage} lost)</span>}</td>
                    <td className="pr-3"><span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_STYLE[t.status]}`}>{t.status.replace('_', ' ')}</span></td>
                    <td className="text-right whitespace-nowrap">
                      {t.status === 'IN_TRANSIT' && incoming && <button type="button" className="underline text-emerald-700 mr-3" onClick={() => setReceiving(t)}>Receive</button>}
                      {t.status === 'IN_TRANSIT' && !incoming && <button type="button" className="underline text-red-600" onClick={() => cancel(t)}>Cancel</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <NewTransfer branchId={branchId} outlets={outlets} stockRows={stockRows} onClose={() => setShowNew(false)} onDone={() => { void load(); onChanged(); }} />}
      {receiving && <ReceiveDialog transfer={receiving} onClose={() => setReceiving(null)} onDone={() => { void load(); onChanged(); }} />}
    </div>
  );
}

function NewTransfer({ branchId, outlets, stockRows, onClose, onDone }: { branchId: string; outlets: Outlet[]; stockRows: StockRow[]; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState(outlets[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = useMemo(() => stockRows.filter((r) => Number(qty[r.productId]) > 0), [stockRows, qty]);
  const q = search.trim().toLowerCase();
  const visible = stockRows.filter((r) => r.quantity > 0 && (!q || r.name.toLowerCase().includes(q)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post('/transfers', {
        fromBranchId: branchId, toBranchId: to, ...(note.trim() ? { note: note.trim() } : {}),
        items: lines.map((r) => ({ productId: r.productId, quantity: Number(qty[r.productId]) })),
      });
      showToast('Stock sent: it is on the way', 'success');
      onDone(); onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  };

  return (
    <Modal title="Send stock to another outlet" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-200 text-xs rounded-lg">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold">Send to
            <select id="trTo" className="input-base mt-1 w-full" value={to} onChange={(e) => setTo(e.target.value)}>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">Note
            <input className="input-base mt-1 w-full" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
          </label>
        </div>
        <input className="input-base w-full" placeholder="Search a product" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="max-h-[40vh] overflow-y-auto border rounded-lg dark:border-gray-700">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800"><tr className="text-left text-gray-500"><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">In stock</th><th className="px-3 py-2 text-right">Send</th></tr></thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.productId} className="border-t dark:border-gray-700">
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.quantity}</td>
                  <td className="px-3 py-1.5 text-right">
                    <input className="input-base w-20 text-right font-mono" inputMode="numeric" aria-label={`Send ${r.name}`} value={qty[r.productId] ?? ''}
                      onChange={(e) => setQty({ ...qty, [r.productId]: e.target.value.replace(/\D/g, '') })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">{lines.length} product{lines.length === 1 ? '' : 's'}, {lines.reduce((n, r) => n + Number(qty[r.productId]), 0)} bottles</span>
          <div className="flex gap-3">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg" onClick={onClose}>Cancel</button>
            <button id="trSend" type="submit" disabled={saving || lines.length === 0 || !to} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-60">Send</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ReceiveDialog({ transfer, onClose, onDone }: { transfer: Transfer; onClose: () => void; onDone: () => void }) {
  const [got, setGot] = useState<Record<string, string>>(() => Object.fromEntries(transfer.items.map((i) => [i.productId, String(i.quantity)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(`/transfers/${transfer.id}/receive`, { items: transfer.items.map((i) => ({ productId: i.productId, receivedQuantity: Number(got[i.productId] ?? i.quantity) })) });
      showToast('Stock received', 'success');
      onDone(); onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  };

  return (
    <Modal title={`Receive ${transfer.transferNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-gray-600 dark:text-gray-300">From {transfer.fromBranchName}. Count what actually arrived; a lower number is recorded as lost in transit.</p>
        {error && <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 text-red-800 text-xs rounded-lg">{error}</div>}
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="py-1">Product</th><th className="text-right">Sent</th><th className="text-right">Arrived</th></tr></thead>
          <tbody>
            {transfer.items.map((i) => (
              <tr key={i.productId} className="border-t dark:border-gray-700">
                <td className="py-1.5">{i.name}</td><td className="text-right font-mono">{i.quantity}</td>
                <td className="text-right"><input className="input-base w-20 text-right font-mono" inputMode="numeric" aria-label={`Arrived ${i.name}`} value={got[i.productId] ?? ''}
                  onChange={(e) => setGot({ ...got, [i.productId]: e.target.value.replace(/\D/g, '') })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end gap-3">
          <button type="button" className="px-4 py-2 text-sm border rounded-lg" onClick={onClose}>Cancel</button>
          <button id="trReceive" type="submit" disabled={saving} className="px-5 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-60">Confirm receipt</button>
        </div>
      </form>
    </Modal>
  );
}
