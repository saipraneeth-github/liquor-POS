import { Lock, Moon, Sun } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { Mark } from '../auth/AuthShell';
import { useTheme } from '../context/ThemeContext';
import { SubscriptionPanel } from './SubscriptionPanel';

const HEADLINE: Record<string, string> = {
  TRIAL_EXPIRED: 'Your free trial has ended',
  OVERDUE: 'Your subscription payment is overdue',
};

/** Shown instead of the app when a business's trial ended or its payment lapsed. The Admin can pay right here. */
export function SubscriptionLocked() {
  const { user, saasRole, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const isAdmin = saasRole === 'admin';

  return (
    <div className="lc" id="subscriptionLocked" style={{ minHeight: '100dvh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px 48px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Mark />
            <b style={{ font: '700 17px var(--font-display)' }}>Liquor Counter</b>
          </div>
          <button type="button" className="lc-btn lc-btn-ghost" style={{ padding: '6px 12px', fontSize: 13 }} onClick={toggleTheme} aria-label="Toggle dark/light theme">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>

        <div className="lc-card" style={{ display: 'flex', gap: 16, alignItems: 'flex-start', padding: 20 }}>
          <span style={{ display: 'grid', placeItems: 'center', width: 44, height: 44, borderRadius: 12, background: 'var(--warn-soft)', color: 'var(--warn)', flex: 'none' }} aria-hidden="true">
            <Lock size={22} />
          </span>
          <div>
            <h1 style={{ margin: 0, font: '700 24px/1.2 var(--font-display)', letterSpacing: '-.015em' }}>{HEADLINE[user?.access ?? ''] ?? 'Access is paused'}</h1>
            <p style={{ margin: '6px 0 0', color: 'var(--muted)' }}>
              {isAdmin
                ? 'Pay below and everything opens again immediately. Your data is safe.'
                : "Your business's subscription needs attention. Please ask the owner to open the app and complete the payment."}
            </p>
          </div>
        </div>

        {isAdmin && <SubscriptionPanel showPlans onChanged={() => window.location.assign('/settings')} />}

        <button
          type="button"
          className="lc-link"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => { logout(); window.location.assign('/login'); }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
