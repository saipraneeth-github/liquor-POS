import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage } from '../lib/print';
import { Modal } from '../components/ui';

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
  'pos',
  'shift',
  'bills',
  'customers',
  'tables',
  'products',
  'stock',
  'counter',
  'schemes',
  'compliance',
  'accounting',
  'closing',
  'admin',
];

export function Admin() {
  const { user } = useAuth();
  const branchId = user?.branchId;
  const isOwner = user?.role === 'owner';

  const [users, setUsers] = useState<UserItem[]>([]);
  const [terminals, setTerminals] = useState<TerminalItem[]>([]);
  const [loading, setLoading] = useState(false);

  // New user form
  const [nuName, setNuName] = useState('');
  const [nuEmail, setNuEmail] = useState('');
  const [nuPass, setNuPass] = useState('');
  const [nuRole, setNuRole] = useState(isOwner ? 'manager' : 'cashier');
  const [creatingUser, setCreatingUser] = useState(false);

  // New terminal form
  const [ntName, setNtName] = useState('');
  const [creatingTerminal, setCreatingTerminal] = useState(false);

  // Page permissions modal
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userPages, setUserPages] = useState<Set<string>>(new Set());
  const [loadingPages, setLoadingPages] = useState(false);

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
      const [uRes, tRes] = await Promise.all([
        api.get<UserItem[]>('/users?branchId=' + branchId),
        api.get<TerminalItem[]>('/terminals/' + branchId),
      ]);
      setUsers(uRes);
      setTerminals(tRes);
    } catch (err: any) {
      showToast('Failed to load admin data: ' + err.message, 'error');
    } finally {
      setLoading(false);
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
    try {
      const res = await api.get<{ pages: { routePath: string; canAccess: boolean }[] }>(`/users/${id}/pages`);
      const allowed = new Set(res.pages.filter((p) => p.canAccess).map((p) => p.routePath));
      setUserPages(allowed);
    } catch {
      setUserPages(new Set());
    } finally {
      setLoadingPages(false);
    }
  };

  const handleSavePages = async () => {
    if (!editingUserId) return;
    try {
      await api.put(`/users/${editingUserId}/pages`, {
        pages: Array.from(userPages).map((p) => ({ routePath: p, canAccess: true })),
      });
      showToast('Page permissions saved', 'success');
      setEditingUserId(null);
    } catch (err: any) {
      showToast('Failed to save pages: ' + err.message, 'error');
    }
  };

  const roles = isOwner ? ['manager', 'cashier', 'steward'] : ['cashier', 'steward'];

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
      <h2 className="h1 text-xl font-bold mb-4" id="adminTitle">⚙ Administration</h2>

      <div className="card pad stack p-6 bg-white rounded shadow mb-6 flex flex-col gap-4">
        <div className="h2 text-lg font-bold border-b pb-2">👥 Users</div>
        <div id="userList" className="table-wrap overflow-x-auto text-sm">
          {loading ? (
            <div className="p-4 text-center text-gray-500">Loading users…</div>
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
                    <td className="py-2 px-3 font-medium capitalize">{u.role}</td>
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
                      ) : (
                        <div className="row flex items-center gap-2">
                          <button
                            type="button"
                            className="btn-sec btn-sm px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-xs"
                            onClick={() => handleToggleUserActive(u.id, !u.isActive)}
                          >
                            {u.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            className="btn-sec btn-sm px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-xs"
                            onClick={() => openPagesModal(u.id)}
                          >
                            Pages
                          </button>
                          <button
                            type="button"
                            className="user-reset btn-sec btn-sm px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-xs"
                            onClick={() => resetPassword(u.id)}
                          >
                            Reset password
                          </button>
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
                  {r}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-full">
            <button
              className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm disabled:opacity-50"
              type="submit"
              id="nuSubmit"
              disabled={creatingUser}
            >
              {creatingUser ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </div>

      <div className="card pad stack p-6 bg-white rounded shadow mb-6 flex flex-col gap-4">
        <div className="h2 text-lg font-bold border-b pb-2">🖥 Terminals</div>
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
          <button
            className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm disabled:opacity-50"
            type="submit"
            disabled={creatingTerminal}
          >
            {creatingTerminal ? 'Adding…' : 'Add terminal'}
          </button>
        </form>
      </div>

      {editingUserId && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-1" id="modalTitle">Page permissions</h3>
            <div className="muted small text-xs text-gray-500 mb-4">
              Optional page matrix used by page-guarded features. Owners bypass it.
            </div>

            {loadingPages ? (
              <div className="state p-4 text-center text-gray-500">⏳ Loading…</div>
            ) : (
              <div className="flex flex-col gap-3" id="modalBody">
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
                    className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium"
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

