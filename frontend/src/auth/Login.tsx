import { useState } from 'react';
import { useAuth, type User } from './AuthProvider';
import { useTheme } from '../context/ThemeContext';
import { api } from '../api/client';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../lib/print';
import { Sun, Moon } from 'lucide-react';

export function Login() {
  const [email, setEmail] = useState('cashier@liquor.com');
  const [password, setPassword] = useState('Password@123');
  const [loginError, setLoginError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login, error: contextError } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  // Show auth-context errors (e.g. session expiry on restore) once
  const displayError = loginError || contextError || '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setIsSubmitting(true);
    try {
      // Step 1: exchange credentials for token
      const { token } = await api.post<{ token: string }>('/auth/login', { email, password });
      // Step 2: store token so /me request is authenticated
      localStorage.setItem('token', token);
      // Step 3: fetch real user profile (id, name, role, branchId, …)
      const freshUser = await api.get<User>('/me');
      login(token, freshUser);
      navigate(freshUser.role === 'owner' && !freshUser.syndicateId ? '/platform' : '/');
    } catch (err: unknown) {
      setLoginError(errorMessage(err) || 'Login failed');
      // Clear the token if /me failed so we don't get stuck with a bad token
      localStorage.removeItem('token');
    } finally {
      setIsSubmitting(false);
    }
  };

  const loginAs = (role: string) => {
    setEmail(role === 'superadmin' ? 'superadmin@liquor.com' : `${role}@liquor.com`);
    setPassword('Password@123');
  };

  return (
    <div className="relative flex min-h-dvh p-4 items-center justify-center bg-gray-50 dark:bg-gray-900 transition-colors" id="loginPage">
      {/* Theme toggle in top right */}
      <button
        id="loginThemeBtn"
        type="button"
        onClick={toggleTheme}
        className="absolute top-4 right-4 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 shadow-sm transition-colors cursor-pointer flex items-center gap-2 text-xs font-medium"
        aria-label="Toggle dark/light theme"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? (
          <>
            <Sun size={18} className="text-amber-400" />
            <span className="hidden sm:inline">Light</span>
          </>
        ) : (
          <>
            <Moon size={18} className="text-purple-600" />
            <span className="hidden sm:inline">Dark</span>
          </>
        )}
      </button>

      <div className="w-full max-w-md p-8 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700">
        <h1 className="text-2xl font-bold mb-6 text-center text-gray-900 dark:text-white">Liquor Counter POS</h1>
        {displayError && (
          <div className="text-red-500 mb-4 text-center text-sm" id="loginError">{displayError}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">Email</label>
            <input
              id="loginEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
              required
              aria-required="true"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">Password</label>
            <input
              id="loginPass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
              required
              aria-required="true"
            />
          </div>
          <button
            type="submit"
            id="loginBtn"
            className="w-full bg-purple-600 text-white p-2.5 rounded-lg font-semibold hover:bg-purple-700 transition-colors cursor-pointer disabled:opacity-50"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </button>
        </form>
        <div className="mt-3 text-center">
          <Link to="/forgot-password" id="forgotLink" className="text-sm text-purple-600 dark:text-purple-400 hover:underline">Forgot password?</Link>
        </div>
        <div className="mt-6 text-center border-t dark:border-gray-700 pt-4">
          <div className="text-gray-500 dark:text-gray-400 text-xs mb-2">Demo accounts</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button type="button" onClick={() => loginAs('superadmin')} className="p-2 border dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">🛡 Super Admin</button>
            <button type="button" onClick={() => loginAs('owner')} className="p-2 border dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">👑 Admin</button>
            <button type="button" onClick={() => loginAs('manager')} className="p-2 border dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">🛠 Manager</button>
            <button type="button" onClick={() => loginAs('cashier')} className="p-2 border dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">💰 Cashier</button>
            <button type="button" onClick={() => loginAs('steward')} className="p-2 border dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 col-span-2">🍽 Steward</button>
          </div>
        </div>
      </div>
    </div>
  );
}
