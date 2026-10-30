import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

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
};

export function ProtectedRoute() {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) {
    return <Navigate to="/login" replace />;
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
