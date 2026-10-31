import { useEffect, useState } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, type SaasRole } from '../auth/AuthProvider';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';
import { Field, Modal } from './ui';
import {
  LayoutDashboard,
  ShoppingCart,
  Clock,
  Receipt,
  Users,
  Coffee,
  Wine,
  Package,
  UtensilsCrossed,
  GlassWater,
  ClipboardList,
  Droplets,
  Target,
  ShieldCheck,
  BookOpen,
  Lock,
  Settings,
  Building2,
  Globe,
  LogOut,
} from 'lucide-react';

type NavItem = {
  path: string;
  label: string;
  icon: typeof Wine;
  id: string;
  min: 'steward' | 'cashier' | 'manager' | 'owner';
  group: string;
  /** Restrict an item to one SaaS role (e.g. the Platform console is Super Admin only). */
  only?: SaasRole;
};

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, id: 'nav-dashboard', min: 'steward', group: 'Overview' },

  { path: '/pos', label: 'POS Billing', icon: ShoppingCart, id: 'nav-pos', min: 'cashier', group: 'Sell' },
  { path: '/shift', label: 'Shift', icon: Clock, id: 'nav-shift', min: 'cashier', group: 'Sell' },
  { path: '/bills', label: 'Bills', icon: Receipt, id: 'nav-bills', min: 'cashier', group: 'Sell' },
  { path: '/tables', label: 'Tables & KOT', icon: Coffee, id: 'nav-tables', min: 'steward', group: 'Sell' },
  { path: '/customers', label: 'Customers', icon: Users, id: 'nav-customers', min: 'cashier', group: 'Sell' },

  { path: '/menu/kitchen', label: 'Kitchen Menu', icon: UtensilsCrossed, id: 'nav-menu-kitchen', min: 'steward', group: 'Menu & Stock' },
  { path: '/menu/bar', label: 'Bar Menu', icon: GlassWater, id: 'nav-menu-bar', min: 'steward', group: 'Menu & Stock' },
  { path: '/products', label: 'Products', icon: Wine, id: 'nav-products', min: 'cashier', group: 'Menu & Stock' },
  { path: '/inventory', label: 'Inventory', icon: Package, id: 'nav-inventory', min: 'cashier', group: 'Menu & Stock' },
  { path: '/counter', label: 'Counter Sheet', icon: ClipboardList, id: 'nav-counter', min: 'cashier', group: 'Menu & Stock' },
  { path: '/pour', label: 'Pour Control', icon: Droplets, id: 'nav-pour', min: 'manager', group: 'Menu & Stock' },

  { path: '/schemes', label: 'Schemes', icon: Target, id: 'nav-schemes', min: 'manager', group: 'Money & Compliance' },
  { path: '/compliance', label: 'Compliance', icon: ShieldCheck, id: 'nav-compliance', min: 'manager', group: 'Money & Compliance' },
  { path: '/accounting', label: 'Accounting', icon: BookOpen, id: 'nav-accounting', min: 'manager', group: 'Money & Compliance' },
  { path: '/closing', label: 'Day Closing', icon: Lock, id: 'nav-closing', min: 'manager', group: 'Money & Compliance' },

  { path: '/admin', label: 'Staff & Terminals', icon: Settings, id: 'nav-admin', min: 'manager', group: 'Business' },
  { path: '/settings', label: 'Business Settings', icon: Building2, id: 'nav-settings', min: 'owner', group: 'Business', only: 'admin' },

  { path: '/platform', label: 'Platform Console', icon: Globe, id: 'nav-platform', min: 'owner', group: 'Platform', only: 'super_admin' },
];

const roleRank = { steward: 1, cashier: 2, manager: 3, owner: 4 };

const ROLE_LABEL: Record<SaasRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  manager: 'manager',
  cashier: 'cashier',
  steward: 'steward',
};

export function Layout() {
  const { user, logout, saasRole, branches, activeBranchId, setActiveBranch } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showSignoutWarning, setShowSignoutWarning] = useState(false);
  const [dueAmount, setDueAmount] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState<string | null>(null);

  // A Super Admin "support sign-in" keeps the original token so there is a way back
  const supportLabel = localStorage.getItem('support_return_token') ? localStorage.getItem('support_label') : null;
  const exitSupport = () => {
    localStorage.setItem('token', localStorage.getItem('support_return_token') ?? '');
    localStorage.removeItem('support_return_token');
    localStorage.removeItem('support_label');
    localStorage.removeItem('activeBranchId');
    window.location.assign('/platform');
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);
    try {
      await api.post('/auth/change-password', { currentPassword: pw.current, newPassword: pw.next });
      showToast('Password changed.');
      setPwOpen(false);
      setPw({ current: '', next: '' });
    } catch (err) {
      setPwError(errorMessage(err));
    }
  };

  useEffect(() => {
    if (saasRole !== 'admin') return;
    api.get<{ invoices: { status: string; amount: string }[] }>('/tenant/invoices')
      .then((r) => setDueAmount(r.invoices.find((i) => i.status === 'PENDING')?.amount ?? null))
      .catch(() => setDueAmount(null));
  }, [saasRole, location.pathname]);

  if (!user) return null;

  const userRank = roleRank[user.role as keyof typeof roleRank] || 0;
  const sub = (user as any)?.sub ?? user?.id ?? '';
  const activeBranch = branches.find((b) => b.id === activeBranchId);

  const getPendingQueueCount = (): number => {
    try {
      const q = JSON.parse(localStorage.getItem(`lc_offline_bills:${sub}`) || '[]');
      return q.length;
    } catch {
      return 0;
    }
  };

  const handleLogoutClick = () => {
    const pending = getPendingQueueCount();
    if (pending > 0) {
      setShowSignoutWarning(true);
      return;
    }
    doLogout();
  };

  const doLogout = () => {
    setShowSignoutWarning(false);
    logout();
    navigate('/login');
  };

  const visible = navItems.filter(
    (item) => userRank >= roleRank[item.min] && (!item.only || item.only === saasRole),
  );
  // The Super Admin works in the Platform console; branch-level pages need a branch they do not have
  const items = saasRole === 'super_admin' ? visible.filter((i) => i.group === 'Platform' || i.group === 'Overview') : visible;
  const groups = [...new Set(items.map((i) => i.group))];
  const pageTitle = navItems.find((i) => i.path === location.pathname)?.label || '';

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100" id="mainApp">
      <aside className="w-64 bg-white dark:bg-gray-800 border-r dark:border-gray-700 flex flex-col">
        <div className="p-4 font-bold text-xl border-b dark:border-gray-700 flex items-center gap-2">
          <Wine className="text-purple-600" />
          <div>
            <div className="font-bold">Liquor Counter</div>
            <div className="text-xs text-gray-500" id="sidebarBranch">
              {saasRole === 'super_admin' ? 'Platform' : activeBranch ? `${activeBranch.code} — ${activeBranch.name}` : 'MAIN-01 — Main Counter Branch'}
            </div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-4 space-y-4">
          {groups.map((group) => (
            <div key={group} className="space-y-1">
              {groups.length > 1 && (
                <div className="px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{group}</div>
              )}
              {items.filter((i) => i.group === group).map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    id={item.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded transition-colors ${
                      isActive
                        ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    <Icon size={18} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="p-4 border-t dark:border-gray-700">
          <div className="mb-4 text-sm">
            <div id="userDisplay" className="font-semibold">{user.name} ({saasRole ? ROLE_LABEL[saasRole] : user.role})</div>
            <div id="emailDisplay" className="text-gray-500">{user.email}</div>
          </div>
          <button
            type="button"
            id="changePasswordBtn"
            onClick={() => { setPwError(null); setPwOpen(true); }}
            className="w-full mb-2 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:underline cursor-pointer"
          >
            Change password
          </button>
          <button
            onClick={handleLogoutClick}
            className="flex items-center justify-center gap-2 w-full px-3 py-2 text-red-600 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
          >
            <LogOut size={18} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {dueAmount && location.pathname !== '/settings' && (
          <div id="billingBanner" className="bg-purple-100 text-purple-900 text-sm px-4 py-1.5 flex items-center justify-between">
            <span>A subscription invoice of <b>₹{Number(dueAmount).toLocaleString('en-IN')}</b> is waiting.</span>
            <Link to="/settings" className="font-semibold underline">Pay now</Link>
          </div>
        )}
        {supportLabel && (
          <div id="supportBanner" className="bg-amber-100 text-amber-900 text-sm px-4 py-1.5 flex items-center justify-between">
            <span>Support session — you are signed in as <b>{supportLabel}</b>. Every action is recorded.</span>
            <button type="button" id="supportExit" onClick={exitSupport} className="font-semibold underline cursor-pointer">Exit support session</button>
          </div>
        )}
        <header className="h-14 bg-white dark:bg-gray-800 border-b dark:border-gray-700 flex items-center justify-between px-4">
          <div className="font-semibold text-lg" id="pageTitle">{pageTitle}</div>
          <div className="flex items-center gap-4 text-sm">
            {user.role === 'owner' && branches.length > 0 && saasRole !== 'super_admin' && (
              <label className="flex items-center gap-2">
                <span className="text-gray-500">Branch</span>
                <select
                  id="branchSelect"
                  className="p-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                  value={activeBranchId ?? ''}
                  onChange={(e) => setActiveBranch(e.target.value)}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4">
          {/* Re-mount pages when the owner switches branch so they reload that branch's data */}
          <Outlet key={activeBranchId ?? 'none'} />
        </main>
      </div>

      {pwOpen && (
        <Modal title="Change password" onClose={() => setPwOpen(false)}>
          <form onSubmit={changePassword} className="space-y-4">
            {pwError && <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg">{pwError}</div>}
            <Field label="Current password">
              <input id="pwCurrent" className="input-base" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <input id="pwNew" className="input-base" type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
            </Field>
            <div className="flex justify-end gap-3">
              <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setPwOpen(false)}>Cancel</button>
              <button id="pwSave" type="submit" className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer">Change password</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Sign-out with unsynced bills warning modal */}
      {showSignoutWarning && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 border dark:border-gray-700">
            <h2 className="text-lg font-bold text-red-600 mb-2" id="modalTitle">
              Sign out with unsynced bills?
            </h2>
            <div id="modalBody" className="text-sm text-gray-600 dark:text-gray-300 mb-6">
              You have {getPendingQueueCount()} offline bill(s) that have not reached the server yet.
              They stay on this device and are sent only when you sign in here again — other users will not submit them.
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                id="confirmCancel"
                onClick={() => setShowSignoutWarning(false)}
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                id="confirmOk"
                onClick={doLogout}
                className="px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold hover:bg-red-700"
              >
                Sign out anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
