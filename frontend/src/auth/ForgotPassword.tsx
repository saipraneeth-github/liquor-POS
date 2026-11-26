import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { errorMessage } from '../lib/print';
import { AuthShell } from './AuthShell';

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
    <AuthShell id="forgotPage" heading="Reset your password" text="">
      <h1>Forgot your password?</h1>
      {sent ? (
        <>
          <div className="lc-alert good" id="forgotSent" role="status">
            <span>If this email is registered, check your inbox for a link. It works for one hour.</span>
          </div>
          <Link to="/login" className="lc-link" style={{ alignSelf: 'flex-start', marginLeft: -6 }}>Back to sign in</Link>
        </>
      ) : (
        <form onSubmit={submit} className="lc-login-form" style={{ padding: 0, maxWidth: 'none' }}>
          <p className="lead">Enter the email you use to sign in.</p>
          {error && <div className="lc-alert bad" role="alert"><span>{error}</span></div>}
          <div className="lc-field">
            <label htmlFor="forgotEmail">Email</label>
            <div className="lc-input">
              <input id="forgotEmail" type="email" required autoFocus autoComplete="username" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <button id="forgotSubmit" type="submit" disabled={busy} aria-busy={busy} className="lc-btn lc-btn-primary">
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
          <Link to="/login" className="lc-link" style={{ alignSelf: 'flex-start', marginLeft: -6 }}>Back to sign in</Link>
        </form>
      )}
    </AuthShell>
  );
}
