import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';

type Err = {
  id: string; source: 'SERVER' | 'BROWSER'; message: string; stack: string | null; route: string | null; method: string | null; status: number | null;
  occurrences: number; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null; release: string | null; userAgent: string | null;
};

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Super Admin: every distinct error the app has hit (server and browser), counted, newest first. */
export function PlatformErrors() {
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [source, setSource] = useState<'' | 'SERVER' | 'BROWSER'>('');
  const [errors, setErrors] = useState<Err[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [openCount, setOpenCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ errors: Err[]; open: number }>(`/platform/errors?status=${status}${source ? `&source=${source}` : ''}`);
      setErrors(r.errors); setOpenCount(r.open);
    } catch (err) { showToast(errorMessage(err), 'error'); }
  }, [status, source]);
  useEffect(() => { void load(); }, [load]);

  const resolve = async (e: Err) => {
    try { await api.post(`/platform/errors/${e.id}/resolve`); showToast('Marked resolved (it reopens by itself if it happens again)', 'success'); await load(); }
    catch (err) { showToast(errorMessage(err), 'error'); }
  };

  return (
    <div id="page-platform-errors" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold">Errors</h2>
          <p className="text-xs text-gray-500">{openCount} open. Each row is one distinct error, counted. Messages are scrubbed of e-mail addresses and phone numbers.</p>
        </div>
        <div className="flex gap-3">
          <select id="errStatus" className="input-base" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option>
          </select>
          <select id="errSource" className="input-base" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="">Server and browser</option><option value="SERVER">Server</option><option value="BROWSER">Browser</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto border rounded-lg dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="px-3 py-2">Error</th><th className="px-3 py-2">Where</th><th className="px-3 py-2 text-right">Times</th><th className="px-3 py-2">Last seen</th><th /></tr></thead>
          <tbody>
            {errors.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-500">Nothing here. No errors in this view.</td></tr>}
            {errors.map((e) => (
              <Fragment key={e.id}>
                <tr className="border-t dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td className="px-3 py-2 max-w-md"><span className={`mr-2 px-1.5 py-0.5 rounded text-[10px] font-semibold ${e.source === 'SERVER' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'}`}>{e.source}</span>{e.message}</td>
                  <td className="px-3 py-2 font-mono">{e.method} {e.route}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold">{e.occurrences}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{when(e.lastSeenAt)}</td>
                  <td className="px-3 py-2 text-right">{!e.resolvedAt && <button type="button" className="underline" onClick={(ev) => { ev.stopPropagation(); void resolve(e); }}>Resolve</button>}</td>
                </tr>
                {open === e.id && (
                  <tr className="bg-gray-50 dark:bg-gray-800/60">
                    <td colSpan={5} className="px-3 py-2">
                      <div className="text-[11px] text-gray-500 mb-1">First seen {when(e.firstSeenAt)}{e.status ? ` · HTTP ${e.status}` : ''}{e.release ? ` · release ${e.release}` : ''}{e.userAgent ? ` · ${e.userAgent}` : ''}</div>
                      <pre className="text-[11px] whitespace-pre-wrap font-mono text-gray-700 dark:text-gray-300 max-h-64 overflow-y-auto">{e.stack ?? '(no stack trace)'}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
