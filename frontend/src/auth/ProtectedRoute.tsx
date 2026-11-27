import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { canOpenPage, defaultPage } from './navigation';
import { SubscriptionLocked } from '../billing/SubscriptionLocked';

import { BeerBottleLoader } from '../components/BeerBottleLoader';

export function ProtectedRoute() {
  const { user, loading, disabledFeatures } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-slate-950" id="sessionLoading">
        <BeerBottleLoader inline size="md" title="Loading your shop…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Trial ended / payment overdue: the only screen is the one where the Admin can pay
  if (user.access && user.access !== 'OK') return <SubscriptionLocked />;

  if (!canOpenPage(user, location.pathname, disabledFeatures)) {
    const landing = defaultPage(user, disabledFeatures);
    if (landing) return <Navigate to={landing} replace />;
    // Layout renders a recovery message when every page is disabled.
  }

  return <Outlet />;
}
