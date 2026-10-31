import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { errorMessage } from '../lib/print';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900 p-4" id="forgotPage">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-6 space-y-4">
        <h1 className="text-xl font-bold">Forgot your password?</h1>
        {sent ? (
          <p className="text-sm text-gray-600 dark:text-gray-300" id="forgotSent">
            If that address has an account, a reset link is on its way. It works for one hour. Check your spam folder if it does not arrive.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-gray-500">Enter the e-mail you sign in with and we will send you a link to choose a new password.</p>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <input id="forgotEmail" className="input-base" type="email" required autoFocus placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button id="forgotSubmit" type="submit" disabled={busy} className="w-full py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}
        <Link to="/login" className="block text-sm text-purple-600 hover:underline">Back to sign in</Link>
      </div>
    </div>
  );
}
