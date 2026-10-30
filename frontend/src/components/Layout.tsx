import { useState } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import {
  LayoutDashboard,
  ShoppingCart,
  Clock,
  Receipt,
  Users,
  Coffee,
  Wine,
  Package,
  ClipboardList,
  Target,
  ShieldCheck,
  BookOpen,
  Lock,
  Settings,
  LogOut
} from 'lucide-react';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, id: 'nav-dashboard', min: 'steward' },
  { path: '/pos', label: 'POS Billing', icon: ShoppingCart, id: 'nav-pos', min: 'cashier' },
  { path: '/shift', label: 'Shift', icon: Clock, id: 'nav-shift', min: 'cashier' },
  { path: '/bills', label: 'Bills', icon: Receipt, id: 'nav-bills', min: 'cashier' },
  { path: '/customers', label: 'Customers', icon: Users, id: 'nav-customers', min: 'cashier' },
  { path: '/tables', label: 'Tables & KOT', icon: Coffee, id: 'nav-tables', min: 'steward' },
  { path: '/products', label: 'Products', icon: Wine, id: 'nav-products', min: 'cashier' },
  { path: '/inventory', label: 'Inventory', icon: Package, id: 'nav-inventory', min: 'cashier' },
  { path: '/counter', label: 'Counter Sheet', icon: ClipboardList, id: 'nav-counter', min: 'cashier' },
  { path: '/schemes', label: 'Schemes', icon: Target, id: 'nav-schemes', min: 'manager' },
  { path: '/compliance', label: 'Compliance', icon: ShieldCheck, id: 'nav-compliance', min: 'manager' },
  { path: '/accounting', label: 'Accounting', icon: BookOpen, id: 'nav-accounting', min: 'manager' },
  { path: '/closing', label: 'Day Closing', icon: Lock, id: 'nav-closing', min: 'manager' },
  { path: '/admin', label: 'Admin', icon: Settings, id: 'nav-admin', min: 'manager' },
];

const roleRank = { steward: 1, cashier: 2, manager: 3, owner: 4 };

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showSignoutWarning, setShowSignoutWarning] = useState(false);

  if (!user) return null;

  const userRank = roleRank[user.role as keyof typeof roleRank] || 0;
  const sub = (user as any)?.sub ?? user?.id ?? '';

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

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100" id="mainApp">
      <aside className="w-64 bg-white dark:bg-gray-800 border-r dark:border-gray-700 flex flex-col">
        <div className="p-4 font-bold text-xl border-b dark:border-gray-700 flex items-center gap-2">
          <Wine className="text-purple-600" />
          <div>
            <div className="font-bold">Liquor Counter</div>
            <div className="text-xs text-gray-500" id="sidebarBranch">MAIN-01 — Main Counter Branch</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {navItems.map((item) => {
            const reqRank = roleRank[item.min as keyof typeof roleRank];
            if (userRank < reqRank) return null;

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
        </nav>
        <div className="p-4 border-t dark:border-gray-700">
          <div className="mb-4 text-sm">
            <div id="userDisplay" className="font-semibold">{user.name} ({user.role})</div>
            <div id="emailDisplay" className="text-gray-500">{user.email}</div>
          </div>
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
        <header className="h-14 bg-white dark:bg-gray-800 border-b dark:border-gray-700 flex items-center justify-between px-4">
          <div className="font-semibold text-lg" id="pageTitle">
             {navItems.find(i => i.path === location.pathname)?.label || ''}
          </div>
          <div className="flex items-center gap-4 text-sm">
            {/* Header hooks if needed */}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4">
          <Outlet />
        </main>
      </div>

      <div id="toastHost" className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"></div>

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