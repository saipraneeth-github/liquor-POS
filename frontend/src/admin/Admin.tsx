import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage } from '../lib/print';
import { Modal, ProtectedButton } from '../components/ui';
import { BeerBottleLoader } from '../components/BeerBottleLoader';

interface UserItem {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
}

interface TerminalItem {
  id: string;
  terminalName: string;
  isActive: boolean;
}

const PAGE_KEYS = [
  'dashboard',
  'pos',
  'shift',
  'bills',
  'customers',
  'tables',
  'menu/kitchen',
  'menu/bar',
  'products',
  'inventory',
  'counter',
  'pour',
  'schemes',
  'compliance',
  'accounting',
  'bank',
  'closing',
  'admin',
];

const PAGE_MIN_ROLE: Record<string, string> = {
  dashboard: 'steward',
  pos: 'cashier',
  shift: 'cashier',
  bills: 'cashier',
  customers: 'cashier',
  tables: 'steward',
  'menu/kitchen': 'steward',
  'menu/bar': 'steward',
  products: 'cashier',
  inventory: 'cashier',
  counter: 'cashier',
  pour: 'manager',
  schemes: 'manager',
  compliance: 'manager',
  accounting: 'manager',
  bank: 'manager',
  closing: 'manager',
  admin: 'manager',
};

const ROLE_RANK: Record<string, number> = { steward: 1, cashier: 2, manager: 3, office_admin: 3.5, owner: 4 };

interface PermissionRow { key: string; label: string; description: string; roleDefault: boolean; override: boolean | null; effective: boolean }
interface PermissionData {
  role: string;
  unrestricted: boolean;
  permissions: PermissionRow[];
  discountCapPct: number | null;
  canLimitSaleTypes: boolean;
  saleTypes: { id: string; name: string; isDefault: boolean }[];
  saleTypeIds: string[];
}

export function Admin() {
  const { user, activeBranchId, branches } = useAuth();
  const branchId = activeBranchId ?? user?.branchId ?? branches[0]?.id;
  const isOwner = user?.role === 'owner';
  const isOfficeAdmin = user?.role === 'office_admin';

  const [users, setUsers] = useState<UserItem[]>([]);
  const [terminals, setTerminals] = useState<TerminalItem[]>([]);
  const [saleTypes, setSaleTypes] = useState<{ id: string; name: string; code: string; isDefault: boolean; enabled: boolean }[]>([]);
  const [loading, setLoading] = useState(false);

  // New user form
  const [nuName, setNuName] = useState('');
  const [nuEmail, setNuEmail] = useState('');
  const [nuPass, setNuPass] = useState('');
  const [nuRole, setNuRole] = useState(isOwner || isOfficeAdmin ? 'manager' : 'cashier');
  const [creatingUser, setCreatingUser] = useState(false);

  // New terminal form
  const [ntName, setNtName] = useState('');
  const [creatingTerminal, setCreatingTerminal] = useState(false);

  // Page permissions modal
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userPages, setUserPages] = useState<Set<string>>(new Set());
  const [loadingPages, setLoadingPages] = useState(false);
  // What the user may do (cost prices, prices, stock moves, approvals, voids, big discounts) + which sale types a cashier may use
  const [permData, setPermData] = useState<PermissionData | null>(null);
  const [permEdits, setPermEdits] = useState<Record<string, boolean>>({});    // key → effective value being edited
  const [limitTypes, setLimitTypes] = useState<Set<string>>(new Set());

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type} ${type === 'error' ? 'bg-red-600' : 'bg-emerald-600'} text-white p-3 rounded shadow`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const loadData = async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const [uRes, tRes, stRes] = await Promise.all([
        api.get<UserItem[]>('/users?branchId=' + branchId),
        api.get<TerminalItem[]>('/terminals/' + branchId),
        api.get<any[]>('/sale-types/' + branchId + '?all=1').catch(() => []),
      ]);
      setUsers(uRes);
      setTerminals(tRes);
      setSaleTypes(stRes || []);
    } catch (err: any) {
      showToast('Failed to load admin data: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const toggleSaleType = async (st: { id: string; enabled: boolean; name: string }) => {
    if (!branchId) return;
    try {
      await api.patch(`/sale-types/${branchId}/${st.id}`, { enabled: !st.enabled });
      showToast(`${st.name} counter is now ${!st.enabled ? 'Enabled' : 'Disabled'}.`, 'success');
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
      await loadData();
    } catch (err: any) {
      showToast('Could not change sale type: ' + err.message, 'error');
    }
  };

  useEffect(() => {
    loadData();
  }, [branchId]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    if (nuPass.length < 8) {
      showToast('Password must be at least 8 characters.', 'error');
      return;
    }
    setCreatingUser(true);
    try {
      await api.post('/users', {
        name: nuName.trim(),
        email: nuEmail.trim(),
        password: nuPass,
        role: nuRole,
        branchId,
      });
      showToast('User created: ' + nuEmail.trim(), 'success');
      setNuName('');
      setNuEmail('');
      setNuPass('');
      await loadData();
    } catch (err: any) {
      showToast('Could not create user: ' + err.message, 'error');
    } finally {
      setCreatingUser(false);
    }
  };

  const handleToggleUserActive = async (id: string, nextActive: boolean) => {
    try {
      await api.patch('/users/' + id, { isActive: nextActive });
      showToast(nextActive ? 'User activated' : 'User deactivated', 'success');
      await loadData();
    } catch (err: any) {
      showToast('Update failed: ' + err.message, 'error');
    }
  };

  const handleCreateTerminal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    setCreatingTerminal(true);
    try {
      await api.post('/terminals/' + branchId, { terminalName: ntName.trim() });
      showToast('Terminal created', 'success');
      setNtName('');
      await loadData();
    } catch (err: any) {
      showToast('Could not create terminal: ' + err.message, 'error');
    } finally {
      setCreatingTerminal(false);
    }
  };

  const openPagesModal = async (id: string) => {
    setEditingUserId(id);
    setLoadingPages(true);
    const targetUser = users.find((u) => u.id === id);
    const rank = ROLE_RANK[targetUser?.role || 'cashier'] || 2;
    const defaults = PAGE_KEYS.filter((k) => rank >= (ROLE_RANK[PAGE_MIN_ROLE[k]] || 2));
    try {
      const perm = await api.get<PermissionData>(`/users/${id}/permissions`);
      setPermData(perm);
      setPermEdits(Object.fromEntries(perm.permissions.map((q) => [q.key, q.effective])));
      setLimitTypes(new Set(perm.saleTypeIds));
    } catch {
      setPermData(null);
    }
    try {
      const res = await api.get<{ pages: { routePath: string; canAccess: boolean }[] }>(`/users/${id}/pages`);
      if (res.pages.length === 0) {
        setUserPages(new Set(defaults));
      } else {
        const allowed = new Set(
          res.pages
            .filter((p) => p.canAccess)
            .map((p) => (p.routePath === 'stock' ? 'inventory' : p.routePath))
        );
        setUserPages(allowed);
      }
    } catch {
      setUserPages(new Set(defaults));
    } finally {
      setLoadingPages(false);
    }
  };

  const handleSavePages = async () => {
    if (!editingUserId) return;
    try {
      await api.put(`/users/${editingUserId}/pages`, {
        pages: PAGE_KEYS.map((p) => ({ routePath: p, canAccess: userPages.has(p) })),
      });
      if (permData && !permData.unrestricted) {
        // only what differs from the role's default is stored
        const overrides = Object.fromEntries(permData.permissions.map((q) => [q.key, permEdits[q.key] === q.roleDefault ? null : permEdits[q.key]]));
        await api.put(`/users/${editingUserId}/permissions`, { overrides, saleTypeIds: permData.canLimitSaleTypes ? [...limitTypes] : [] });
      }
      showToast('Access saved', 'success');
      setEditingUserId(null);
    } catch (err: any) {
      showToast('Failed to save pages: ' + errorMessage(err), 'error');
    }
  };

  // who can create whom: an office admin has owner-level power, so only the owner creates one; a manager creates cashiers and stewards
  const roles = isOwner ? ['manager', 'office_admin', 'cashier', 'steward'] : isOfficeAdmin ? ['manager', 'cashier', 'steward'] : ['cashier', 'steward'];

  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);

  const resetPassword = async (id: string) => {
    try {
      const res = await api.post<{ email: string; temporaryPassword: string }>('/users/' + id + '/reset-password');
      setRevealed({ email: res.email, password: res.temporaryPassword });
    } catch (err) {
      alertToast(errorMessage(err));
    }
  };

  const alertToast = (msg: string) => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast error bg-red-600 text-white p-3 rounded-lg shadow-lg text-sm mb-2';
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  };

  return (
    <section className="page active" id="page-admin" aria-labelledby="adminTitle">
      <div className="mb-5">
        <h2 className="text-2xl font-bold" id="adminTitle">Administration</h2>
        <p className="text-sm text-gray-500 mt-0.5">Who can sign in at this branch, what each person can open, and which counters are set up.</p>
      </div>

      <div className="card pad stack p-6 bg-white rounded shadow mb-6 flex flex-col gap-4">
        <div className="h2 text-lg font-bold border-b pb-2">Users</div>
        <div id="userList" className="table-wrap overflow-x-auto text-sm">
          {loading ? (
            <BeerBottleLoader inline size="sm" title="Loading Staff & Users…" subtitle="Fetching branch user accounts and roles…" />
          ) : users.length === 0 ? (
            <div className="muted small text-gray-500">No users in this branch.</div>
          ) : (
            <table className="table w-full text-left">
              <thead>
                <tr className="border-b text-xs text-gray-500 bg-gray-50">
                  <th className="py-2 px-3">User</th>
                  <th className="py-2 px-3">Role</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b hover:bg-gray-50" data-email={u.email}>
                    <td className="py-2 px-3">
                      <b>{u.name}</b>
                      <div className="muted small text-xs text-gray-500">{u.email}</div>
                    </td>
                    <td className="py-2 px-3 font-medium">{u.role === 'office_admin' ? 'Office Admin' : u.role}</td>
                    <td className="py-2 px-3">
                      <span
                        className={`badge text-xs px-2 py-0.5 rounded font-medium ${
                          u.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {u.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      {u.id === user?.id ? (
                        <span className="muted small text-xs text-gray-500">You</span>
                      ) : (ROLE_RANK[u.role] ?? 0) >= (ROLE_RANK[user?.role ?? 'steward'] ?? 0) && user?.role !== 'owner' ? (
                        <span className="muted small text-xs text-gray-500" title="You can only manage people below your own role">—</span>
                      ) : (
                        <div className="row flex items-center gap-2">
                          <ProtectedButton
                            type="button"
                            variant={u.isActive ? 'danger' : 'secondary'}
                            minRole="manager"
                            confirmMessage={u.isActive ? 'Deactivate this user? They will not be able to log in until reactivated.' : undefined}
                            confirmLabel="Deactivate"
                            className="px-2.5 py-1 text-xs"
                            onClick={() => handleToggleUserActive(u.id, !u.isActive)}
                          >
                            {u.isActive ? 'Deactivate' : 'Activate'}
                          </ProtectedButton>
                          <button
                            type="button"
                            className="btn-sec btn-sm px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-xs"
                            onClick={() => openPagesModal(u.id)}
                          >
                            Access
                          </button>
                          <ProtectedButton
                            type="button"
                            variant="secondary"
                            minRole="manager"
                            confirmMessage="Reset password for this user? A temporary password will be generated."
                            confirmLabel="Reset password"
                            className="user-reset px-2.5 py-1 text-xs"
                            onClick={() => resetPassword(u.id)}
                          >
                            Reset password
                          </ProtectedButton>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <form className="form-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 pt-3 border-t" onSubmit={handleCreateUser}>
          <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="nuName">
            Name
            <input
              id="nuName"
              className="input p-2 border rounded text-sm"
              required
              maxLength={100}
              value={nuName}
              onChange={(e) => setNuName(e.target.value)}
            />
          </label>
          <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="nuEmail">
            Email
            <input
              id="nuEmail"
              className="input p-2 border rounded text-sm"
              type="email"
              required
              value={nuEmail}
              onChange={(e) => setNuEmail(e.target.value)}
            />
          </label>
          <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="nuPass">
            Password
            <input
              id="nuPass"
              className="input p-2 border rounded text-sm"
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
              value={nuPass}
              onChange={(e) => setNuPass(e.target.value)}
            />
          </label>
          <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="nuRole">
            Role
            <select
              id="nuRole"
              className="input p-2 border rounded text-sm"
              value={nuRole}
              onChange={(e) => setNuRole(e.target.value)}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r === 'office_admin' ? 'Office Admin' : r}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-full">
            <ProtectedButton
              type="submit"
              id="nuSubmit"
              minRole="manager"
              loading={creatingUser}
              disabled={creatingUser}
              className="px-4 py-2 font-medium text-sm"
            >
              Create user
            </ProtectedButton>
          </div>
        </form>
      </div>

      <div className="card pad stack p-6 bg-white rounded shadow mb-6 flex flex-col gap-4">
        <div className="h2 text-lg font-bold border-b pb-2">Terminals</div>
        <div id="terminalList" className="table-wrap overflow-x-auto text-sm">
          {terminals.length === 0 ? (
            <div className="muted small text-gray-500">No terminals.</div>
          ) : (
            <table className="table w-full text-left">
              <thead>
                <tr className="border-b text-xs text-gray-500 bg-gray-50">
                  <th className="py-2 px-3">Terminal name</th>
                  <th className="py-2 px-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {terminals.map((t) => (
                  <tr key={t.id} className="border-b">
                    <td className="py-2 px-3 font-medium">{t.terminalName}</td>
                    <td className="py-2 px-3">
                      <span className="badge text-xs px-2 py-0.5 rounded font-medium bg-green-100 text-green-800">
                        Active
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <form className="form-grid flex flex-wrap items-end gap-3 pt-3 border-t" onSubmit={handleCreateTerminal}>
          <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="ntName" style={{ minWidth: '220px' }}>
            Terminal name
            <input
              id="ntName"
              className="input p-2 border rounded text-sm"
              required
              maxLength={100}
              placeholder="Counter 2"
              value={ntName}
              onChange={(e) => setNtName(e.target.value)}
            />
          </label>
          <ProtectedButton
            type="submit"
            minRole="manager"
            loading={creatingTerminal}
            disabled={creatingTerminal}
            className="px-4 py-2 font-medium text-sm"
          >
            Add terminal
          </ProtectedButton>
        </form>
      </div>

      {/* Sale Types & Counters Management (Janata, Walk-in) */}
      <div className="card pad stack p-6 bg-white dark:bg-gray-800 rounded shadow mb-6 flex flex-col gap-4 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100" id="saleTypesManagement">
        <div>
          <div className="h2 text-lg font-bold border-b pb-2">Sale Counters & Types</div>
          <div className="text-xs text-gray-500 mt-1">
            Turn counters on or off for this outlet. Janata and other alternate sale types can be toggled here.
          </div>
        </div>

        <div className="table-wrap overflow-x-auto text-sm">
          {saleTypes.length === 0 ? (
            <div className="muted small text-gray-500">No sale counters found.</div>
          ) : (
            <table className="table w-full text-left">
              <thead>
                <tr className="border-b text-xs text-gray-500 bg-gray-50 dark:bg-gray-900">
                  <th className="py-2 px-3">Counter / Sale Type</th>
                  <th className="py-2 px-3">Type</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {saleTypes.map((st) => (
                  <tr key={st.id} className="border-b">
                    <td className="py-2.5 px-3 font-semibold">{st.name}</td>
                    <td className="py-2.5 px-3 text-xs text-gray-500">
                      {st.isDefault ? 'Default Counter (Walk-in)' : 'Alternate Counter'}
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`text-xs px-2.5 py-1 rounded font-semibold ${
                        st.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                      }`}>
                        {st.enabled ? 'ON / Active' : 'OFF / Disabled'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {st.isDefault ? (
                        <span className="text-xs text-gray-400 italic">Always Active</span>
                      ) : (
                        <ProtectedButton
                          type="button"
                          minRole="manager"
                          onClick={() => toggleSaleType(st)}
                          className={`px-3 py-1 text-xs font-semibold rounded cursor-pointer ${
                            st.enabled
                              ? 'bg-red-50 hover:bg-red-100 text-red-700 border border-red-200'
                              : 'bg-green-600 hover:bg-green-700 text-white'
                          }`}
                        >
                          {st.enabled ? 'Turn OFF' : 'Turn ON'}
                        </ProtectedButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {editingUserId && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50">
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl max-w-2xl w-full p-6">
            <div className="flex justify-between items-start mb-1">
              <h3 className="text-lg font-bold" id="modalTitle">Access — {users.find((x) => x.id === editingUserId)?.name}</h3>
              <button
                type="button"
                onClick={() => setEditingUserId(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>
            <div className="muted small text-xs text-gray-500 dark:text-gray-400 mb-4">
              Which pages this person sees, what they may do, and which sale types they may sell. Owners and office admins always have everything.
            </div>

            {loadingPages ? (
              <BeerBottleLoader inline size="sm" title="Loading Permissions…" subtitle="Fetching page access rights…" />
            ) : (
              <div className="flex flex-col gap-3" id="modalBody">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Pages</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {PAGE_KEYS.map((k) => (
                    <label key={k} className="check flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={userPages.has(k)}
                        onChange={(e) => {
                          const next = new Set(userPages);
                          if (e.target.checked) next.add(k);
                          else next.delete(k);
                          setUserPages(next);
                        }}
                      />
                      <span>{k}</span>
                    </label>
                  ))}
                </div>

                {permData && (
                  <div id="permissionSection" className="pt-3 border-t space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">What they can do</div>
                    {permData.unrestricted ? (
                      <p className="text-sm text-gray-600 dark:text-gray-300">An {permData.role === 'owner' ? 'owner' : 'office admin'} always has every permission and cannot be restricted.</p>
                    ) : (
                      <div className="space-y-2">
                        {permData.permissions.map((q) => (
                          <label key={q.key} className="flex items-start gap-2 text-sm" data-permission={q.key}>
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={permEdits[q.key] ?? false}
                              onChange={(e) => setPermEdits({ ...permEdits, [q.key]: e.target.checked })}
                            />
                            <span>
                              <span className="font-medium">{q.label}</span>
                              {permEdits[q.key] !== q.roleDefault && <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{permEdits[q.key] ? 'extra' : 'removed'}</span>}
                              <span className="block text-xs text-gray-500">{q.description}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}

                    {permData.canLimitSaleTypes && permData.saleTypes.length > 1 && (
                      <div id="saleTypeSection" className="pt-3 border-t">
                        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Sale types they may bill and count</div>
                        <p className="text-xs text-gray-500 mb-2">Tick the ones this person may use. Leave all unticked to allow every sale type.</p>
                        <div className="flex flex-wrap gap-4 text-sm">
                          {permData.saleTypes.map((t) => (
                            <label key={t.id} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={limitTypes.has(t.id)}
                                onChange={(e) => {
                                  const next = new Set(limitTypes);
                                  if (e.target.checked) next.add(t.id);
                                  else next.delete(t.id);
                                  setLimitTypes(next);
                                }}
                              />
                              {t.name}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="flex justify-end gap-3 pt-4 border-t">
                  <button
                    type="button"
                    className="btn-sec px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-sm font-medium"
                    onClick={() => setEditingUserId(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm font-medium"
                    onClick={handleSavePages}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {revealed && (
        <Modal title="Temporary password" onClose={() => setRevealed(null)}>
          <p className="text-sm text-gray-600">Give this to <b>{revealed.email}</b>. It is shown only once; they can change it after signing in.</p>
          <div id="revealedPassword" className="my-4 p-3 text-center font-mono text-lg tracking-wider bg-gray-50 border rounded-lg select-all">{revealed.password}</div>
          <div className="flex justify-end"><button type="button" className="px-4 py-2 text-sm font-semibold bg-purple-600 text-white rounded-lg" onClick={() => setRevealed(null)}>Done</button></div>
        </Modal>
      )}    </section>

  );
}

