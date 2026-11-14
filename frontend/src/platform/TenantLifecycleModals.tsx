import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Field, Modal, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { fmtDay } from './planUi';

interface TenantLite { id: string; name: string; archivedAt?: string | null; archiveReason?: string | null; exportedAt?: string | null }

/** Downloads everything the business owns as a JSON file, and returns how many records it held. */
export async function downloadTenantExport(t: { id: string; name: string }): Promise<number> {
  const data = await api.get<{ rowCount: number }>(`/platform/tenants/${t.id}/export`);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business'}-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  return data.rowCount;
}

/** Archive: blocks everyone, keeps everything. A reason is required and recorded. */
export function ArchiveModal({ tenant, onClose, onDone }: { tenant: TenantLite; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bad = reason.trim().length < 3;

  const submit = async () => {
    setTouched(true);
    if (bad) return;
    setBusy(true);
    try {
      await api.post(`/platform/tenants/${tenant.id}/archive`, { reason: reason.trim() });
      showToast(`${tenant.name} archived. It can be deleted after 30 days.`, 'success');
      onDone();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };

  return (
    <Modal title={`Archive ${tenant.name}?`} onClose={onClose}>
      <div className="space-y-3" id="archiveForm">
        <ul className="text-sm text-gray-600 dark:text-gray-300 list-disc pl-5 space-y-1">
          <li>Everyone in this business is signed out and cannot sign in.</li>
          <li>It leaves the dashboard figures and the active list. Billing stops.</li>
          <li>Nothing is deleted. You can restore it at any time, and delete it for good only after 30 days.</li>
        </ul>
        <Field label="Why is it being archived?">
          <textarea id="archiveReason" className="input-base min-h-[4.5rem]" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Stopped trading, never paid, asked to close" />
          {touched && bad && <div className="text-xs text-red-600 mt-0.5">Say why (at least 3 characters)</div>}
        </Field>
        {error && <div id="archiveError" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>}
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={onClose}>Cancel</button>
          <button type="button" id="archiveOk" disabled={busy} onClick={() => void submit()} className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">Archive</button>
        </div>
      </div>
    </Modal>
  );
}

interface DeletePreview {
  name: string;
  archived: boolean;
  archivedAt: string | null;
  archiveReason: string | null;
  eligibleFrom: string | null;
  daysLeft: number | null;
  eligible: boolean;
  unpaidInvoices: { count: number; amount: string };
  exportedAt: string | null;
  totalRows: number;
  tables: { table: string; rows: number }[];
}

const LABEL: Record<string, string> = {
  bills: 'bills', bill_items: 'bill lines', customers: 'customers', credit_transactions: 'credit entries', users: 'users', branches: 'branches',
  products: 'products', stock: 'stock records', stock_audit: 'stock movements', journal_vouchers: 'accounting vouchers', journal_lines: 'voucher lines',
  expenses: 'expenses', supplier_invoices: 'supplier invoices', bank_statements: 'bank statements', bank_statement_lines: 'bank lines',
};

/**
 * Permanent delete. Shows exactly what goes, nudges towards downloading it first, and only enables the button once the
 * business has waited out its 30 days, nothing is unpaid, the name is typed and the warning is ticked.
 */
export function DeleteTenantModal({ tenant, onClose, onDone }: { tenant: TenantLite; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState<DeletePreview | null>(null);
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<string | null>(tenant.exportedAt ?? null);

  useEffect(() => {
    let live = true;
    api.get<DeletePreview>(`/platform/tenants/${tenant.id}/delete-preview`).then((r) => { if (live) setP(r); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [tenant.id]);

  const exportNow = async () => {
    setBusy(true);
    try { const n = await downloadTenantExport(tenant); setExported(new Date().toISOString()); showToast(`Downloaded ${n} records`, 'success'); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const nameMatches = !!p && typed.trim() === p.name.trim();
  const blockers: string[] = [];
  if (p && !p.eligible) blockers.push(p.daysLeft ? `Too soon: it can be deleted from ${fmtDay(p.eligibleFrom)} (${p.daysLeft} more day${p.daysLeft === 1 ? '' : 's'}).` : 'It must be archived first.');
  if (p && p.unpaidInvoices.count > 0) blockers.push(`It has ${p.unpaidInvoices.count} unpaid invoice${p.unpaidInvoices.count === 1 ? '' : 's'} (${inr(p.unpaidInvoices.amount)}). Open Billing and void or settle them first.`);
  const canDelete = !!p && blockers.length === 0 && nameMatches && ack && !busy;

  const remove = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ rows: number }>(`/platform/tenants/${tenant.id}/delete`, { confirmName: typed, acknowledge: true });
      showToast(`${tenant.name} deleted (${r.rows} records)`, 'success');
      onDone();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };

  const top = p?.tables.filter((t) => LABEL[t.table]).slice(0, 6) ?? [];

  return (
    <Modal title={`Delete ${tenant.name} permanently`} onClose={onClose}>
      <div className="space-y-3" id="deleteForm">
        {!p && !error && <div id="deleteLoading" aria-busy="true" className="h-28 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />}
        {p && (
          <>
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 text-sm">
              <b>This cannot be undone.</b> {p.totalRows.toLocaleString('en-IN')} records are removed for good
              {top.length > 0 && <>: {top.map((t) => `${t.rows.toLocaleString('en-IN')} ${LABEL[t.table]}`).join(', ')}…</>}
              <div className="text-xs text-gray-600 mt-1">Archived {fmtDay(p.archivedAt)}{p.archiveReason ? ` — ${p.archiveReason}` : ''}. The audit log keeps a record that it happened.</div>
            </div>

            <div className={`p-3 rounded-lg border text-sm flex flex-wrap items-center justify-between gap-2 ${exported ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`} id="exportBox">
              <span>{exported ? <>Data downloaded on {fmtDay(exported)}.</> : <>Their books are legal records. <b>Download a copy before deleting.</b></>}</span>
              <button type="button" id="exportData" disabled={busy} onClick={() => void exportNow()} className="px-3 py-1.5 text-xs font-semibold border rounded-lg bg-white hover:bg-gray-50 cursor-pointer disabled:opacity-50">{exported ? 'Download again' : 'Download data'}</button>
            </div>

            {blockers.map((b) => <div key={b} className="deleteBlocker p-2.5 rounded-lg bg-gray-100 dark:bg-gray-800 border text-sm text-gray-700 dark:text-gray-200">{b}</div>)}

            <Field label={`Type the business name to confirm: ${p.name}`}>
              <input id="deleteConfirmName" className="input-base" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder={p.name} />
            </Field>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input id="deleteAck" type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand all of this business's data will be deleted permanently and cannot be recovered.</span>
            </label>
          </>
        )}
        {error && <div id="deleteError" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>}
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={onClose}>Cancel</button>
          <button type="button" id="deleteOk" disabled={!canDelete} onClick={() => void remove()} className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg cursor-pointer">Delete permanently</button>
        </div>
      </div>
    </Modal>
  );
}
