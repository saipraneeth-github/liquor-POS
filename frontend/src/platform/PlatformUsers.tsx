import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Modal } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';

type Role = 'owner' | 'office_admin' | 'manager' | 'cashier' | 'steward';

interface PUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  roleName: string | null;
  isActive: boolean;
  tenant: string | null;
  tenantId: string | null;
  branch: string | null;
  lastLoginAt: string | null;
  isPlatformOwner: boolean;
}
interface UsersPage { users: PUser[]; total: number; limit: number; offset: number }
interface TenantOption { id: string; name: string }

const PAGE = 25;
export const ROLE_LABEL: Record<Role, string> = { owner: 'Admin / owner', office_admin: 'Office admin', manager: 'Manager', cashier: 'Cashier', steward: 'Steward' };

const when = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never');

/** Every user of every business: find one, switch an account off, or give them a temporary password. */
export function PlatformUsers() {
  const [data, setData] = useState<UsersPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [confirm, setConfirm] = useState<PUser | null>(null);
  const [reveal, setReveal] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [changingRole, setChangingRole] = useState<PUser | null>(null);
  const [assignable, setAssignable] = useState<{ id: string; name: string; level: string; isSystem: boolean }[]>([]);
  const [pickRole, setPickRole] = useState('');
  const [roleError, setRoleError] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => { setDebounced(search.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => {
    api.get<{ tenants: TenantOption[] }>('/platform/tenants').then((r) => setTenants(r.tenants)).catch(() => setTenants([]));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (debounced) qs.set('search', debounced);
    if (tenantId) qs.set('tenantId', tenantId);
    if (role) qs.set('role', role);
    if (status) qs.set('status', status);
    try { setData(await api.get<UsersPage>(`/platform/users?${qs}`)); } catch (err) { setError(errorMessage(err)); }
  }, [debounced, tenantId, role, status, offset]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const setActive = async (u: PUser, isActive: boolean) => {
    setBusy(true);
    try {
      await api.patch(`/platform/users/${u.id}`, { isActive });
      showToast(isActive ? `${u.name} can sign in again` : `${u.name} is switched off and signed out`, 'success');
      setConfirm(null);
      await load();
    } catch (err) { showToast(errorMessage(err), 'error'); } finally { setBusy(false); }
  };
  const openRole = async (u: PUser) => {
    setRoleError(null);
    setPickRole('');
    setChangingRole(u);
    try { setAssignable((await api.get<{ assignable: typeof assignable }>('/platform/roles')).assignable); } catch (err) { setRoleError(errorMessage(err)); }
  };
  const saveRole = async () => {
    if (!changingRole || !pickRole) return;
    setBusy(true);
    try {
      await api.put(`/platform/users/${changingRole.id}/role`, { roleId: pickRole });
      showToast(`${changingRole.name} now has the role ${assignable.find((r) => r.id === pickRole)?.name}`, 'success');
      setChangingRole(null);
      await load();
    } catch (err) { setRoleError(errorMessage(err)); } finally { setBusy(false); }
  };
  const resetPassword = async (u: PUser) => {
    try {
      const r = await api.post<{ email: string; temporaryPassword: string }>(`/platform/users/${u.id}/reset-password`);
      setReveal({ email: r.email, password: r.temporaryPassword });
    } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  const filtered = Boolean(debounced || tenantId || role || status);
  const clear = () => { setSearch(''); setTenantId(''); setRole(''); setStatus(''); setOffset(0); };
  const input = 'p-2 border rounded-lg text-sm bg-white dark:bg-gray-800 dark:border-gray-600';

  const actions = (u: PUser) => u.isPlatformOwner
    ? <span className="text-xs text-gray-400">Platform owner</span>
    : (
      <span className="flex flex-wrap gap-1.5">
        {u.role !== 'owner' && u.role !== 'office_admin' && <button type="button" data-action="role" onClick={() => void openRole(u)} className="px-2.5 py-1 text-xs border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Change role</button>}
        <button type="button" data-action="reset" onClick={() => void resetPassword(u)} className="px-2.5 py-1 text-xs border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Reset password</button>
        {u.isActive
          ? <button type="button" data-action="deactivate" onClick={() => setConfirm(u)} className="px-2.5 py-1 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50 cursor-pointer">Deactivate</button>
          : <button type="button" data-action="activate" onClick={() => void setActive(u, true)} className="px-2.5 py-1 text-xs border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 cursor-pointer">Reactivate</button>}
      </span>
    );

  return (
    <section className="page active p-4 md:p-6 max-w-7xl mx-auto space-y-4" id="page-platform-users">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50" id="platformUsersTitle">Users</h1>
        <p className="text-sm text-gray-500 mt-0.5">Everyone who can sign in, across every business.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2" id="puFilters">
        <input id="puSearch" className={`${input} w-64`} placeholder="Search name or e-mail" aria-label="Search users" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select id="puTenant" aria-label="Business" className={input} value={tenantId} onChange={(e) => { setTenantId(e.target.value); setOffset(0); }}>
          <option value="">All businesses</option>
          {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select id="puRole" aria-label="Role" className={input} value={role} onChange={(e) => { setRole(e.target.value); setOffset(0); }}>
          <option value="">All roles</option>
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <select id="puStatus" aria-label="Status" className={input} value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">Active and inactive</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {filtered && <button type="button" id="puClear" onClick={clear} className="text-sm text-purple-700 font-semibold hover:underline cursor-pointer">Clear filters</button>}
        {data && <span className="ml-auto text-xs text-gray-500">{data.total} user{data.total === 1 ? '' : 's'}</span>}
      </div>

      {error ? (
        <div id="puError" className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm flex items-center justify-between gap-3">
          <span>{error}</span><button type="button" onClick={() => void load()} className="px-3 py-1.5 border border-red-300 rounded-lg font-semibold cursor-pointer">Retry</button>
        </div>
      ) : data === null ? (
        <div id="puLoading" aria-busy="true" className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />)}</div>
      ) : data.users.length === 0 ? (
        <div id="puEmpty" className="p-10 text-center text-sm text-gray-500 border border-dashed rounded-xl">
          {filtered ? <>No users match. <button type="button" onClick={clear} className="text-purple-700 font-semibold hover:underline cursor-pointer">Clear filters</button></> : 'No users yet.'}
        </div>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
            <table className="w-full text-left text-sm" id="puTable">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-gray-500 bg-gray-50 dark:bg-gray-900/40 dark:border-gray-700">
                  {['Name', 'Role', 'Business', 'Branch', 'Status', 'Last sign-in', 'Actions'].map((h) => <th key={h} className="py-2.5 px-4">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data.users.map((u) => (
                  <tr key={u.id} data-user-row={u.email}>
                    <td className="py-3 px-4"><div className="font-semibold">{u.name}</div><div className="text-xs text-gray-500">{u.email}</div></td>
                    <td className="py-3 px-4" data-cell="role">{u.roleName ?? ROLE_LABEL[u.role]}</td>
                    <td className="py-3 px-4">{u.tenant ?? '—'}</td>
                    <td className="py-3 px-4">{u.branch ?? '—'}</td>
                    <td className="py-3 px-4"><Badge tone={u.isActive ? 'good' : 'muted'}>{u.isActive ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="py-3 px-4 text-xs text-gray-600 whitespace-nowrap">{when(u.lastLoginAt)}</td>
                    <td className="py-3 px-4">{actions(u)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* On a phone: one card per user with the three facts that matter */}
          <div className="md:hidden space-y-2" id="puCards">
            {data.users.map((u) => (
              <div key={u.id} data-user-card={u.email} className="p-3 rounded-xl border bg-white dark:bg-gray-800 dark:border-gray-700 text-sm space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div><div className="font-semibold">{u.name}</div><div className="text-xs text-gray-500 break-all">{u.email}</div></div>
                  <Badge tone={u.isActive ? 'good' : 'muted'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>
                </div>
                <div className="text-xs text-gray-600">{u.roleName ?? ROLE_LABEL[u.role]} · {u.tenant ?? 'No business'}{u.branch ? ` · ${u.branch}` : ''}</div>
                <div className="text-xs text-gray-500">Last sign-in: {when(u.lastLoginAt)}</div>
                <div className="pt-1">{actions(u)}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{data.offset + 1}–{Math.min(data.offset + data.users.length, data.total)} of {data.total}</span>
            <span className="flex gap-2">
              <button type="button" id="puPrev" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="px-3 py-1.5 border rounded-lg disabled:opacity-40 cursor-pointer">Previous</button>
              <button type="button" id="puNext" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} className="px-3 py-1.5 border rounded-lg disabled:opacity-40 cursor-pointer">Next</button>
            </span>
          </div>
        </>
      )}

      {confirm && (
        <Modal title={`Deactivate ${confirm.name}?`} onClose={() => setConfirm(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {confirm.email} is signed out on their next action and cannot sign in until you reactivate the account. Their records are kept.
          </p>
          <div className="flex justify-end gap-3 pt-4">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" id="puDeactivateOk" disabled={busy} className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg cursor-pointer" onClick={() => void setActive(confirm, false)}>Deactivate</button>
          </div>
        </Modal>
      )}

      {changingRole && (
        <Modal title={`Change role — ${changingRole.name}`} onClose={() => setChangingRole(null)}>
          <div className="space-y-3" id="changeRoleForm">
            <p className="text-sm text-gray-600 dark:text-gray-300">Now: <b>{changingRole.roleName ?? ROLE_LABEL[changingRole.role]}</b>. The new role applies on their next action. Exceptions already set for this person are kept.</p>
            <select id="pickRole" className="w-full p-2 border rounded-lg text-sm bg-white dark:bg-gray-800 dark:border-gray-600" value={pickRole} onChange={(e) => setPickRole(e.target.value)}>
              <option value="">Choose a role…</option>
              {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isSystem ? ' (built-in)' : ''}</option>)}
            </select>
            {roleError && <div id="roleChangeError" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{roleError}</div>}
            <div className="flex justify-end gap-3">
              <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setChangingRole(null)}>Cancel</button>
              <button type="button" id="saveRole" disabled={!pickRole || busy} onClick={() => void saveRole()} className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">Change role</button>
            </div>
          </div>
        </Modal>
      )}

      {reveal && (
        <Modal title="Temporary password" onClose={() => setReveal(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300">Give this to <b>{reveal.email}</b>. It is shown only now; they should change it after signing in.</p>
          <div id="puTempPassword" className="mt-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-900/40 border font-mono text-base select-all">{reveal.password}</div>
          <div className="flex justify-end pt-4"><button type="button" className="px-4 py-2 text-sm font-semibold bg-purple-600 text-white rounded-lg cursor-pointer" onClick={() => setReveal(null)}>Done</button></div>
        </Modal>
      )}
    </section>
  );
}
