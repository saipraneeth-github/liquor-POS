import { useAuth } from '../auth/AuthProvider';
import { SubscriptionPanel } from './SubscriptionPanel';

const HEADLINE: Record<string, string> = {
  TRIAL_EXPIRED: 'Your free trial has ended',
  OVERDUE: 'Your subscription payment is overdue',
};

/** Shown instead of the app when a business's trial ended or its payment lapsed. The Admin can pay right here. */
export function SubscriptionLocked() {
  const { user, saasRole, logout } = useAuth();
  const isAdmin = saasRole === 'admin';

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex items-start justify-center p-6" id="subscriptionLocked">
      <div className="w-full max-w-2xl space-y-4 mt-10">
        <div>
          <h1 className="text-2xl font-bold">{HEADLINE[user?.access ?? ''] ?? 'Access is paused'}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {isAdmin
              ? 'Pay below and everything opens again immediately. Your data is safe.'
              : "Your business's subscription needs attention. Please ask the owner to open the app and complete the payment."}
          </p>
        </div>
        {isAdmin && <SubscriptionPanel showPlans onChanged={() => window.location.assign('/settings')} />}
        <button type="button" onClick={() => { logout(); window.location.assign('/login'); }} className="text-sm text-gray-500 hover:underline cursor-pointer">
          Sign out
        </button>
      </div>
    </div>
  );
}
