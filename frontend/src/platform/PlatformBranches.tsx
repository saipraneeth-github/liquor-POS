import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Modal } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { fmtDay } from './planUi';
import { ROLE_LABEL } from './PlatformUsers';

interface BranchRow {
  id: string;
  name: string;
  code: string;
  address: string | null;
  tenantId: string | null;
  tenant: string | null;
  standing: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' | 'NONE';
  staff: number;
  tenantBranches: number;
  tenantMaxBranches: number | null;
  featuresOff: number;
}
interface ListPage { branches: BranchRow[]; total: number; limit: number; offset: number; features: { key: string; label: string }[] }
interface Feature { key: string; label: string; description: string; enabled: boolean; changedAt: string | null; changedBy: string | null }
interface Person { id: string; name: string; email: string; role: keyof typeof ROLE_LABEL; isActive: boolean; lastLoginAt: string | null }
interface Detail {
  id: string; name: string; code: string; address: string | null; gstin: string | null; exciseLicenseNo: string | null;
  tenantId: string | null; tenant: string | null; tenantPlan: string | null; tenantMaxBranches: number | null; tenantBranches: number;
  standing: BranchRow['standing']; features: Feature[]; staff: Person[]; admins: Person[];
}
interface TenantOption { id: string; name: string }

const PAGE = 25;
const STANDING: Record<BranchRow['standing'], { label: string; tone: 'good' | 'warn' | 'muted' }> = {
  ACTIVE: { label: 'Active', tone: 'good' }, SUSPENDED: { label: 'Suspended', tone: 'warn' }, ARCHIVED: { label: 'Archived', tone: 'muted' }, NONE: { label: 'No business', tone: 'muted' },
};

/** Every branch on the platform: whose it is, who works there, and which features it has. */
export function PlatformBranches() {
  const [data, setData] = useState<ListPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [status, setStatus] = useState('');
  const [featureOff, setFeatureOff] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => { setDebounced(search.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { api.get<{ tenants: TenantOption[] }>('/platform/tenants').then((r) => setTenants(r.tenants)).catch(() => setTenants([])); }, []);

  const load = useCallback(async () => {
    setError(null);
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (debounced) qs.set('search', debounced);
    if (tenantId) qs.set('tenantId', tenantId);
    if (status) qs.set('status', status);
    if (featureOff) qs.set('featureOff', featureOff);
    try { setData(await api.get<ListPage>(`/platform/branches?${qs}`)); } catch (err) { setError(errorMessage(err)); }
  }, [debounced, tenantId, status, featureOff, offset]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const filtered = Boolean(debounced || tenantId || status || featureOff);
  const clear = () => { setSearch(''); setTenantId(''); setStatus(''); setFeatureOff(''); setOffset(0); };
  const input = 'p-2 border rounded-lg text-sm bg-white dark:bg-gray-800 dark:border-gray-600';

  const featuresCell = (b: BranchRow) => (b.featuresOff === 0
    ? <span className="text-xs text-gray-500">All on</span>
    : <Badge tone="warn">{b.featuresOff} off</Badge>);

  return (
    <section className="page active p-4 md:p-6 max-w-7xl mx-auto space-y-4" id="page-platform-branches">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50" id="platformBranchesTitle">Branches</h1>
        <p className="text-sm text-gray-500 mt-0.5">Every branch on the platform. Open one to switch its features on or off.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2" id="pbFilters">
        <input id="pbSearch" className={`${input} w-64`} placeholder="Search branch, code, address or business" aria-label="Search branches" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select id="pbTenant" aria-label="Business" className={input} value={tenantId} onChange={(e) => { setTenantId(e.target.value); setOffset(0); }}>
          <option value="">All businesses</option>
          {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select id="pbStatus" aria-label="Business status" className={input} value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="archived">Archived</option>
        </select>
        <select id="pbFeatureOff" aria-label="Feature switched off" className={input} value={featureOff} onChange={(e) => { setFeatureOff(e.target.value); setOffset(0); }}>
          <option value="">Any features</option>
          {(data?.features ?? []).map((f) => <option key={f.key} value={f.key}>{f.label} is off</option>)}
        </select>
        {filtered && <button type="button" id="pbClear" onClick={clear} className="text-sm text-purple-700 font-semibold hover:underline cursor-pointer">Clear filters</button>}
        {data && <span className="ml-auto text-xs text-gray-500">{data.total} branch{data.total === 1 ? '' : 'es'}</span>}
      </div>

      {error ? (
        <div id="pbError" className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm flex items-center justify-between gap-3">
          <span>{error}</span><button type="button" onClick={() => void load()} className="px-3 py-1.5 border border-red-300 rounded-lg font-semibold cursor-pointer">Retry</button>
        </div>
      ) : data === null ? (
        <div id="pbLoading" aria-busy="true" className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />)}</div>
      ) : data.branches.length === 0 ? (
        <div id="pbEmpty" className="p-10 text-center text-sm text-gray-500 border border-dashed rounded-xl">
          {filtered ? <>No branches match. <button type="button" onClick={clear} className="text-purple-700 font-semibold hover:underline cursor-pointer">Clear filters</button></> : 'No branches yet.'}
        </div>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
            <table className="w-full text-left text-sm" id="pbTable">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-gray-500 bg-gray-50 dark:bg-gray-900/40 dark:border-gray-700">
                  {['Branch', 'Business', 'Staff', 'Plan use', 'Features', 'Status', ''].map((h) => <th key={h} className="py-2.5 px-4">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data.branches.map((b) => (
                  <tr key={b.id} data-branch-row={b.code} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                    <td className="py-3 px-4"><div className="font-semibold">{b.name} <span className="font-mono text-xs text-gray-400">{b.code}</span></div><div className="text-xs text-gray-500">{b.address ?? '—'}</div></td>
                    <td className="py-3 px-4">{b.tenant ?? '—'}</td>
                    <td className="py-3 px-4 font-mono">{b.staff}</td>
                    <td className="py-3 px-4 font-mono text-xs">{b.tenantMaxBranches ? `${b.tenantBranches} / ${b.tenantMaxBranches}` : '—'}</td>
                    <td className="py-3 px-4">{featuresCell(b)}</td>
                    <td className="py-3 px-4"><Badge tone={STANDING[b.standing].tone}>{STANDING[b.standing].label}</Badge></td>
                    <td className="py-3 px-4 text-right"><button type="button" data-action="manage" onClick={() => setOpen(b.id)} className="px-3 py-1.5 text-xs font-semibold border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Manage</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* On a phone: a card per branch with the three facts that matter */}
          <div className="md:hidden space-y-2" id="pbCards">
            {data.branches.map((b) => (
              <div key={b.id} data-branch-card={b.code} className="p-3 rounded-xl border bg-white dark:bg-gray-800 dark:border-gray-700 text-sm space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div><div className="font-semibold">{b.name} <span className="font-mono text-xs text-gray-400">{b.code}</span></div><div className="text-xs text-gray-500">{b.tenant ?? 'No business'}</div></div>
                  <Badge tone={STANDING[b.standing].tone}>{STANDING[b.standing].label}</Badge>
                </div>
                <div className="text-xs text-gray-600">{b.staff} staff · {featuresCell(b)}</div>
                <button type="button" onClick={() => setOpen(b.id)} className="px-3 py-1.5 text-xs font-semibold border rounded-lg cursor-pointer">Manage</button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{data.offset + 1}–{Math.min(data.offset + data.branches.length, data.total)} of {data.total}</span>
            <span className="flex gap-2">
              <button type="button" id="pbPrev" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="px-3 py-1.5 border rounded-lg disabled:opacity-40 cursor-pointer">Previous</button>
              <button type="button" id="pbNext" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} className="px-3 py-1.5 border rounded-lg disabled:opacity-40 cursor-pointer">Next</button>
            </span>
          </div>
        </>
      )}

      {open && <BranchDrawer id={open} onClose={() => setOpen(null)} onSaved={() => void load()} />}
    </section>
  );
}

const who = (p: Person) => (
  <li key={p.id} className="flex items-center justify-between gap-3 py-1.5">
    <span className="min-w-0"><span className="font-medium">{p.name}</span> <span className="text-xs text-gray-500 break-all">{p.email}</span></span>
    <span className="text-xs text-gray-500 whitespace-nowrap">{ROLE_LABEL[p.role]}{p.isActive ? '' : ' · inactive'}</span>
  </li>
);

/** One branch: its details, its feature switches (saved together, each change audited), and who can work in it. */
function BranchDrawer({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [want, setWant] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { const r = await api.get<Detail>(`/platform/branches/${id}`); setD(r); setWant(Object.fromEntries(r.features.map((f) => [f.key, f.enabled]))); } catch (e) { setError(errorMessage(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const changed = d ? d.features.filter((f) => want[f.key] !== f.enabled) : [];

  const save = async () => {
    if (!d || changed.length === 0) return;
    setSaving(true);
    try {
      await api.put(`/platform/branches/${id}/features`, { features: Object.fromEntries(changed.map((f) => [f.key, want[f.key]])) });
      showToast(`${changed.length} feature${changed.length === 1 ? '' : 's'} updated for ${d.name}`, 'success');
      await load();
      onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <Modal title={d ? `${d.name} (${d.code})` : 'Branch'} onClose={onClose} wide>
      <div className="space-y-5" id="branchDrawer">
        {error && <div id="bdError" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>}
        {!d && !error && <div id="bdLoading" aria-busy="true" className="h-40 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />}
        {d && (
          <>
            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <div className="flex gap-2"><dt className="w-28 text-gray-500">Business</dt><dd>{d.tenant ?? '—'}{d.tenantPlan ? ` · ${d.tenantPlan}` : ''}</dd></div>
              <div className="flex gap-2"><dt className="w-28 text-gray-500">Branches used</dt><dd>{d.tenantMaxBranches ? `${d.tenantBranches} of ${d.tenantMaxBranches}` : '—'}</dd></div>
              <div className="flex gap-2"><dt className="w-28 text-gray-500">Address</dt><dd>{d.address ?? '—'}</dd></div>
              <div className="flex gap-2"><dt className="w-28 text-gray-500">GSTIN</dt><dd className="font-mono">{d.gstin ?? '—'}</dd></div>
            </dl>

            <section>
              <h3 className="text-sm font-bold mb-1">Features</h3>
              <p className="text-xs text-gray-500 mb-2">A feature that is off disappears from the menu for this branch and its requests are refused. Billing, shifts, products and stock are always on.</p>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700 border rounded-lg dark:border-gray-700" id="bdFeatures">
                {d.features.map((f) => {
                  const dirty = want[f.key] !== f.enabled;
                  return (
                    <li key={f.key} data-feature={f.key} className={`flex items-center justify-between gap-3 px-3 py-2.5 ${dirty ? 'bg-amber-50 dark:bg-amber-950/20' : ''}`}>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">{f.label}</div>
                        <div className="text-xs text-gray-500">{f.description}</div>
                        {!f.enabled && f.changedAt && <div className="text-[11px] text-gray-400">Switched off {fmtDay(f.changedAt)}{f.changedBy ? ` by ${f.changedBy}` : ''}</div>}
                      </div>
                      <label className="inline-flex items-center gap-2 cursor-pointer shrink-0 text-xs font-semibold">
                        <input type="checkbox" role="switch" aria-label={f.label} data-switch={f.key} checked={want[f.key] ?? true} onChange={(e) => setWant({ ...want, [f.key]: e.target.checked })} className="h-4 w-4" />
                        <span className={want[f.key] ? 'text-emerald-700' : 'text-gray-500'}>{want[f.key] ? 'On' : 'Off'}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-end gap-3 mt-3">
                {changed.length > 0 && <span className="text-xs text-amber-700 mr-auto">{changed.length} unsaved change{changed.length === 1 ? '' : 's'}</span>}
                <button type="button" id="bdRevert" disabled={changed.length === 0 || saving} onClick={() => setWant(Object.fromEntries(d.features.map((f) => [f.key, f.enabled])))} className="px-4 py-2 text-sm border rounded-lg disabled:opacity-40 cursor-pointer">Revert</button>
                <button type="button" id="bdSave" disabled={changed.length === 0 || saving} onClick={() => void save()} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white rounded-lg cursor-pointer">Save changes</button>
              </div>
            </section>

            <section>
              <h3 className="text-sm font-bold mb-1">Who can work here</h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-sm" id="bdPeople">
                {d.staff.length === 0 && <li className="py-2 text-xs text-gray-500">No staff are assigned to this branch.</li>}
                {d.staff.map(who)}
              </ul>
              {d.admins.length > 0 && (
                <>
                  <div className="text-xs text-gray-500 mt-3 mb-0.5">Business Admins (every branch of the business)</div>
                  <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">{d.admins.map(who)}</ul>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
