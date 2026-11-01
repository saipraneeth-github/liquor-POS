import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Sun, Moon } from 'lucide-react';
import { api } from '../api/client';
import { errorMessage } from '../lib/print';
import { useTheme } from '../context/ThemeContext';

export function ResetPassword() {
  const { theme, toggleTheme } = useTheme();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/reset-password', { token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-gray-50 dark:bg-gray-900 p-4" id="resetPage">
      <button
        type="button"
        onClick={toggleTheme}
        className="absolute top-4 right-4 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 shadow-sm transition-colors cursor-pointer flex items-center gap-2 text-xs font-medium"
        aria-label="Toggle dark/light theme"
      >
        {theme === 'dark' ? <><Sun size={18} className="text-amber-400" /><span className="hidden sm:inline">Light</span></> : <><Moon size={18} className="text-purple-600" /><span className="hidden sm:inline">Dark</span></>}
      </button>
      <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-6 space-y-4">
        <h1 className="text-xl font-bold">Choose a new password</h1>
        {!token ? (
          <p className="text-sm text-red-600">This link is incomplete. Ask for a new reset link.</p>
        ) : done ? (
          <p className="text-sm text-emerald-700" id="resetDone">Your password has been changed. You can sign in now.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <div className="text-sm text-red-600" id="resetError">{error}</div>}
            <input id="resetNew" className="input-base" type="password" required minLength={8} autoComplete="new-password" placeholder="New password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
            <input id="resetConfirm" className="input-base" type="password" required minLength={8} autoComplete="new-password" placeholder="Repeat the new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <button id="resetSubmit" type="submit" disabled={busy} className="w-full py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">
              {busy ? 'Saving…' : 'Change password'}
            </button>
          </form>
        )}
        <Link to="/login" className="block text-sm text-purple-600 hover:underline">Go to sign in</Link>
      </div>
    </div>
  );
}
