import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';

interface AuditRow {
  id: string;
  action: string;
  actor: string | null;
  actorEmail: string | null;
  tenant: string | null;
  targetType: string | null;
  targetId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}
interface AuditPage { events: AuditRow[]; total: number; limit: number; offset: number }
interface TenantOption { id: string; name: string }

const PAGE = 50;
const when = (v: string) => new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
/** "user.deactivate" → "User deactivate" */
const pretty = (a: string) => a.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Before / after as two columns when the event recorded them, otherwise a plain list of what it carried. */
function Details({ row }: { row: AuditRow }) {
  const meta = row.meta ?? {};
  const before = meta.before as Record<string, unknown> | undefined;
  const after = meta.after as Record<string, unknown> | undefined;
  const rest = Object.entries(meta).filter(([k]) => k !== 'before' && k !== 'after');
  const keys = before || after ? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])] : [];
  return (
    <div className="space-y-3 text-xs" data-audit-detail={row.id}>
      {keys.length > 0 && (
        <table className="border dark:border-gray-700 rounded">
          <thead><tr className="bg-gray-100 dark:bg-gray-900/40 text-gray-500"><th className="px-3 py-1 text-left">Field</th><th className="px-3 py-1 text-left">Before</th><th className="px-3 py-1 text-left">After</th></tr></thead>
          <tbody>
            {keys.map((k) => {
              const changed = show(before?.[k]) !== show(after?.[k]);
              return (
                <tr key={k} className={changed ? 'bg-amber-50 dark:bg-amber-950/20' : ''}>
                  <td className="px-3 py-1 font-mono">{k}</td>
                  <td className="px-3 py-1 font-mono">{show(before?.[k])}</td>
                  <td className="px-3 py-1 font-mono font-semibold">{show(after?.[k])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rest.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
          {rest.map(([k, v]) => (<Fragment key={k}><dt className="text-gray-500">{k}</dt><dd className="font-mono break-all">{show(v)}</dd></Fragment>))}
        </dl>
      )}
      {keys.length === 0 && rest.length === 0 && <div className="text-gray-500">No extra details were recorded for this event.</div>}
      <div className="text-gray-400">{row.targetType ? `${row.targetType}: ${row.targetId ?? ''}` : ''}</div>
    </div>
  );
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Who did what, to which business, when. Read-only. */
export function PlatformAudit() {
  const [data, setData] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [actor, setActor] = useState('');
  const [debouncedActor, setDebouncedActor] = useState('');
  const [action, setAction] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setDebouncedActor(actor.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [actor]);
  useEffect(() => {
    api.get<{ actions: string[] }>('/platform/audit/actions').then((r) => setActions(r.actions)).catch(() => setActions([]));
    api.get<{ tenants: TenantOption[] }>('/platform/tenants').then((r) => setTenants(r.tenants)).catch(() => setTenants([]));
  }, []);

  const query = useCallback((limit: number, off: number) => {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(off) });
    if (debouncedActor) qs.set('actor', debouncedActor);
    if (action) qs.set('action', action);
    if (tenantId) qs.set('tenantId', tenantId);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return qs;
  }, [debouncedActor, action, tenantId, from, to]);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await api.get<AuditPage>(`/platform/audit?${query(PAGE, offset)}`)); } catch (err) { setError(errorMessage(err)); }
  }, [query, offset]);
  useEffect(() => { setData(null); setOpen(null); void load(); }, [load]);

  /** Everything the filters match (up to 1000 rows), as a spreadsheet-ready file. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await api.get<AuditPage>(`/platform/audit?${query(1000, 0)}`);
      const head = ['When', 'Who', 'E-mail', 'What', 'Business', 'Target', 'Target id', 'Details'];
      const lines = all.events.map((e) => [when(e.createdAt), e.actor, e.actorEmail, e.action, e.tenant, e.targetType, e.targetId, e.meta ? JSON.stringify(e.meta) : ''].map(csvCell).join(','));
      const blob = new Blob(['﻿' + [head.map(csvCell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast(all.total > all.events.length ? `Exported the newest ${all.events.length} of ${all.total} events. Narrow the dates to get the rest.` : `Exported ${all.events.length} events`, 'success');
    } catch (err) { showToast(errorMessage(err), 'error'); } finally { setExporting(false); }
  };

  const filtered = Boolean(debouncedActor || action || tenantId || from || to);
  const clear = () => { setActor(''); setAction(''); setTenantId(''); setFrom(''); setTo(''); setOffset(0); };
  const input = 'p-2 border rounded-lg text-sm bg-white dark:bg-gray-800 dark:border-gray-600';

  return (
    <section className="page active p-4 md:p-6 max-w-7xl mx-auto space-y-4" id="page-platform-audit">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50" id="platformAuditTitle">Audit log</h1>
          <p className="text-sm text-gray-500 mt-0.5">A record of changes made on the platform. It cannot be edited.</p>
        </div>
        <button type="button" id="auExport" disabled={exporting || !data || data.total === 0} onClick={() => void exportCsv()} className="px-4 py-2 text-sm border rounded-lg font-semibold hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 cursor-pointer">
          {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2" id="auFilters">
        <input id="auActor" className={`${input} w-52`} placeholder="Who (name or e-mail)" aria-label="Who" value={actor} onChange={(e) => setActor(e.target.value)} />
        <select id="auAction" aria-label="What" className={input} value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }}>
          <option value="">Any action</option>
          {actions.map((a) => <option key={a} value={a}>{pretty(a)}</option>)}
        </select>
        <select id="auTenant" aria-label="Business" className={input} value={tenantId} onChange={(e) => { setTenantId(e.target.value); setOffset(0); }}>
          <option value="">All businesses</option>
          {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-gray-500">From <input id="auFrom" type="date" className={input} value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} /></label>
        <label className="flex items-center gap-1 text-xs text-gray-500">To <input id="auTo" type="date" className={input} value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} /></label>
        {filtered && <button type="button" id="auClear" onClick={clear} className="text-sm text-purple-700 font-semibold hover:underline cursor-pointer">Clear filters</button>}
        {data && <span className="ml-auto text-xs text-gray-500">{data.total} event{data.total === 1 ? '' : 's'}</span>}
      </div>

      {error ? (
        <div id="auError" className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm flex items-center justify-between gap-3">
          <span>{error}</span><button type="button" onClick={() => void load()} className="px-3 py-1.5 border border-red-300 rounded-lg font-semibold cursor-pointer">Retry</button>
        </div>
      ) : data === null ? (
        <div id="auLoading" aria-busy="true" className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />)}</div>
      ) : data.events.length === 0 ? (
        <div id="auEmpty" className="p-10 text-center text-sm text-gray-500 border border-dashed rounded-xl">
          {filtered ? <>No events match. <button type="button" onClick={clear} className="text-purple-700 font-semibold hover:underline cursor-pointer">Clear filters</button></> : 'Nothing has been recorded yet.'}
        </div>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
            <table className="w-full text-left text-sm" id="auTable">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-gray-500 bg-gray-50 dark:bg-gray-900/40 dark:border-gray-700">
                  {['When', 'Who', 'What', 'Business'].map((h) => <th key={h} className="py-2.5 px-4">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data.events.map((e) => (
                  <Fragment key={e.id}>
                    <tr data-audit-row={e.action} aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40">
                      <td className="py-2.5 px-4 text-xs whitespace-nowrap text-gray-600">{when(e.createdAt)}</td>
                      <td className="py-2.5 px-4">{e.actor ?? 'System'}{e.actorEmail && <div className="text-xs text-gray-500">{e.actorEmail}</div>}</td>
                      <td className="py-2.5 px-4"><span className="font-semibold">{pretty(e.action)}</span><div className="text-[11px] font-mono text-gray-400">{e.action}</div></td>
                      <td className="py-2.5 px-4">{e.tenant ?? '—'}</td>
                    </tr>
                    {open === e.id && <tr className="bg-gray-50 dark:bg-gray-900/30"><td colSpan={4} className="px-4 py-3"><Details row={e} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden space-y-2" id="auCards">
            {data.events.map((e) => (
              <div key={e.id} className="p-3 rounded-xl border bg-white dark:bg-gray-800 dark:border-gray-700 text-sm">
                <button type="button" className="w-full text-left cursor-pointer" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <div className="font-semibold">{pretty(e.action)}</div>
                  <div className="text-xs text-gray-600">{e.actor ?? 'System'} · {e.tenant ?? 'No business'}</div>
                  <div className="text-xs text-gray-400">{when(e.createdAt)}</div>
                </button>
                {open === e.id && <div className="mt-2 pt-2 border-t dark:border-gray-700"><Details row={e} /></div>}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{data.offset + 1}–{Math.min(data.offset + data.events.length, data.total)} of {data.total}</span>
            <span className="flex gap-2">
              <button type="button" id="auPrev" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="px-3 py-1.5 border rounded-lg disabled:opacity-40 cursor-pointer">Previous</button>
              <button type="button" id="auNext" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} className="px-3 py-1.5 border rounded-lg disabled:opacity-40 cursor-pointer">Next</button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
