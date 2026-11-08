/**
 * ProtectedButton — a smart action button that handles:
 *   1. Role gating: hides or disables for users below `minRole`
 *   2. Loading / in-flight state: shows spinner, prevents double-submit
 *   3. Confirm dialog: shows an inline modal for destructive actions (no window.confirm)
 *   4. Variants: primary | secondary | danger | ghost | link
 */
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
export type AppRole = 'steward' | 'cashier' | 'manager' | 'owner';

const ROLE_RANK: Record<AppRole, number> = {
  steward: 1,
  cashier: 2,
  manager: 3,
  owner: 4,
};

const VARIANT_CLS: Record<ButtonVariant, string> = {
  primary:
    'bg-purple-600 text-white hover:bg-purple-700 disabled:bg-purple-300 dark:disabled:bg-purple-900',
  secondary:
    'bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700',
  danger:
    'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900',
  ghost:
    'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700',
  link: 'text-purple-600 dark:text-purple-400 hover:underline p-0 h-auto',
};

export interface ProtectedButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  /** If the logged-in user is below this role, the button is hidden entirely. */
  minRole?: AppRole;
  /** If the logged-in user is below this role, the button is shown but disabled with a tooltip. */
  disableBelow?: AppRole;
  /** Visual style. Default: 'primary'. */
  variant?: ButtonVariant;
  /** Show spinner and disable while true. */
  loading?: boolean;
  /**
   * When set, clicking shows an inline confirm dialog with this text before firing `onClick`.
   * Replaces the browser's native window.confirm().
   */
  confirmMessage?: string;
  /** Label for the confirm button. Default: 'Confirm'. */
  confirmLabel?: string;
  /** Async or sync onClick — the button disables itself while the promise is pending. */
  onClick?: () => void | Promise<void>;
  children: ReactNode;
  /** Extra class names on the outer <button>. */
  className?: string;
  /** Icon to show before the label. */
  icon?: ReactNode;
}

export function ProtectedButton({
  minRole,
  disableBelow,
  variant = 'primary',
  loading = false,
  confirmMessage,
  confirmLabel = 'Confirm',
  onClick,
  children,
  className = '',
  icon,
  disabled,
  type = 'button',
  ...rest
}: ProtectedButtonProps) {
  const { user } = useAuth();
  const [inFlight, setInFlight] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const userRank = ROLE_RANK[(user?.role as AppRole) ?? 'steward'] ?? 0;

  // Hide entirely if user is below minRole
  if (minRole && userRank < ROLE_RANK[minRole]) return null;

  const roleLocked = !!disableBelow && userRank < ROLE_RANK[disableBelow];
  const isDisabled = disabled || loading || inFlight || roleLocked;

  const handleClick = async () => {
    if (isDisabled || !onClick) return;
    if (confirmMessage) {
      setShowConfirm(true);
      return;
    }
    await runAction();
  };

  const runAction = async () => {
    if (!onClick) return;
    setInFlight(true);
    try {
      await onClick();
    } finally {
      setInFlight(false);
    }
  };

  const baseCls =
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer';

  const title = roleLocked
    ? `Requires ${disableBelow} role or above`
    : rest.title;

  return (
    <>
      <button
        type={type}
        disabled={isDisabled}
        aria-busy={loading || inFlight || undefined}
        onClick={handleClick}
        className={`${baseCls} ${VARIANT_CLS[variant]} ${className}`}
        title={title}
        {...rest}
      >
        {(loading || inFlight) ? (
          <Loader2 size={16} className="animate-spin" />
        ) : icon ? (
          <span className="shrink-0">{icon}</span>
        ) : null}
        {children}
      </button>

      {/* Inline confirm dialog */}
      {showConfirm && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4"
          onClick={(e) => e.target === e.currentTarget && setShowConfirm(false)}
        >
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-sm w-full p-6 border border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-5 leading-relaxed">
              {confirmMessage}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                onClick={() => setShowConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`px-4 py-2 text-sm font-semibold rounded-lg cursor-pointer ${variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-purple-600 text-white hover:bg-purple-700'}`}
                onClick={async () => {
                  setShowConfirm(false);
                  await runAction();
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
