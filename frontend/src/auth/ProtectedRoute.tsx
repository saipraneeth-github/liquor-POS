import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { SubscriptionLocked } from '../billing/SubscriptionLocked';

const roleRank = { steward: 1, cashier: 2, manager: 3, owner: 4 };

const pageMinRole: Record<string, string> = {
  '/pos': 'cashier',
  '/shift': 'cashier',
  '/bills': 'cashier',
  '/customers': 'cashier',
  '/tables': 'steward',
  '/products': 'cashier',
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
};

// Pages tied to one SaaS role: the Platform console is Super Admin only, Business Settings is Admin only
const pageOnlyRole: Record<string, string> = { '/platform': 'super_admin', '/settings': 'admin' };

export function ProtectedRoute() {
  const { user, saasRole, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-sm text-gray-500" id="sessionLoading">Loading…</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Trial ended / payment overdue: the only screen is the one where the Admin can pay
  if (user.access && user.access !== 'OK') return <SubscriptionLocked />;

  const onlyRole = pageOnlyRole[location.pathname];
  if (onlyRole && onlyRole !== saasRole) {
    return <Navigate to={saasRole === 'super_admin' ? '/platform' : '/'} replace />;
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
        el.className = 'toast error';
        el.textContent = `Your role (${user.role}) cannot open ${routeLabel}.`;
        toastHost.appendChild(el);
        setTimeout(() => el.remove(), 3000);
      }
    }, 50);
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
