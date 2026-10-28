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
    // Injecting directly into DOM for toast host since it's in Layout which might remount or wait
    setTimeout(() => {
      const toastHost = document.getElementById('toastHost');
      if (toastHost) {
        toastHost.innerHTML = `<div class="toast error">cannot open Accounting</div>`;
        setTimeout(() => { toastHost.innerHTML = ''; }, 3000);
      }
    }, 100);
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
