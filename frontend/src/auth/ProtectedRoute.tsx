import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth, userCan } from './AuthProvider';
import { PAGE_PERMISSION, pageDisabled } from '../lib/features';
import { SubscriptionLocked } from '../billing/SubscriptionLocked';

const roleRank = { steward: 1, cashier: 2, manager: 3, owner: 4 };

const pageMinRole: Record<string, string> = {
  '/pos': 'cashier',
  '/shift': 'cashier',
  '/bills': 'cashier',
  '/customers': 'cashier',
  '/tables': 'steward',
  '/products': 'cashier',
  '/invoices': 'cashier',
  '/inventory': 'cashier',
  '/counter': 'cashier',
  '/schemes': 'manager',
  '/compliance': 'manager',
  '/accounting': 'manager',
  '/closing': 'manager',
  '/admin': 'manager',
  '/menu/kitchen': 'steward',
  '/menu/bar': 'steward',
  '/pour': 'manager',
  '/settings': 'owner',
  '/platform': 'owner',
  '/platform/roles': 'owner',
  '/platform/branches': 'owner',
  '/platform/plans': 'owner',
  '/platform/users': 'owner',
  '/platform/audit': 'owner',
};

// Pages tied to one SaaS role: the Platform console is Super Admin only, Business Settings is Admin only
const pageOnlyRole: Record<string, string> = { '/platform': 'super_admin', '/platform/roles': 'super_admin', '/platform/branches': 'super_admin', '/platform/plans': 'super_admin', '/platform/users': 'super_admin', '/platform/audit': 'super_admin' };

import { BeerBottleLoader } from '../components/BeerBottleLoader';

export function ProtectedRoute() {
  const { user, saasRole, loading, disabledFeatures } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-slate-950" id="sessionLoading">
        <BeerBottleLoader inline size="md" title="Chilling & Opening Session…" subtitle="Checking session credentials and active branch…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Trial ended / payment overdue: the only screen is the one where the Admin can pay
  if (user.access && user.access !== 'OK') return <SubscriptionLocked />;

  // The Super Admin has no shop to run: anything that is not a Platform page goes to the Platform console
  if (saasRole === 'super_admin' && !location.pathname.startsWith('/platform')) return <Navigate to="/platform" replace />;

  const onlyRole = pageOnlyRole[location.pathname];
  if (onlyRole && onlyRole !== saasRole) {
    return <Navigate to={saasRole === 'super_admin' ? '/platform' : '/'} replace />;
  }

  // The Super Admin switched this page's feature off for the branch being worked in
  if (saasRole !== 'super_admin' && pageDisabled(location.pathname, disabledFeatures)) {
    setTimeout(() => {
      const toastHost = document.getElementById('toastHost');
      if (toastHost) {
        const el = document.createElement('div');
        el.className = 'toast error bg-red-600 text-white p-3 rounded-lg shadow-lg font-medium text-sm mb-2';
        el.textContent = 'This feature is switched off for this branch. Contact support to turn it on.';
        toastHost.appendChild(el);
        setTimeout(() => el.remove(), 3500);
      }
    }, 50);
    return <Navigate to="/" replace />;
  }

  // A page tied to a permission opens for whoever holds it, whatever their level
  const needs = PAGE_PERMISSION[location.pathname];
  if (needs) {
    if (userCan(user, needs)) return <Outlet />;
    return <Navigate to="/" replace />;
  }

  const reqRole = pageMinRole[location.pathname] || 'steward';
  const reqRank = roleRank[reqRole as keyof typeof roleRank];
  const userRank = roleRank[user.role as keyof typeof roleRank];

  if (userRank < reqRank) {
    // Show toast via the toast host rendered in Layout
    const raw = location.pathname.replace('/', '') || 'this page';
    const routeLabel = raw.charAt(0).toUpperCase() + raw.slice(1);
    setTimeout(() => {
      const toastHost = document.getElementById('toastHost');
      if (toastHost) {
        const el = document.createElement('div');
        el.className = 'toast error bg-red-600 text-white p-3 rounded-lg shadow-lg font-medium text-sm mb-2';
        el.textContent = `Your role (${user.role}) cannot open ${routeLabel}.`;
        toastHost.appendChild(el);
        setTimeout(() => el.remove(), 3000);
      }
    }, 50);
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
