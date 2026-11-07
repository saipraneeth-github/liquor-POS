import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { errorMessage } from '../lib/print';
import { AuthShell } from './AuthShell';

export function ResetPassword() {
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
    <AuthShell id="resetPage" heading="Choose a new password" text="Pick something you will remember and nobody else can guess. At least 8 characters.">
      <h1>Choose a new password</h1>
      {!token ? (
        <>
          <div className="lc-alert bad" role="alert"><span>This link is incomplete. Ask for a new reset link.</span></div>
          <Link to="/forgot-password" className="lc-link" style={{ alignSelf: 'flex-start', marginLeft: -6 }}>Get a new link</Link>
        </>
      ) : done ? (
        <>
          <div className="lc-alert good" id="resetDone" role="status"><span>Your password has been changed. You can sign in now.</span></div>
          <Link to="/login" className="lc-btn lc-btn-primary">Go to sign in</Link>
        </>
      ) : (
        <form onSubmit={submit} className="lc-login-form" style={{ padding: 0, maxWidth: 'none' }}>
          {error && <div className="lc-alert bad" id="resetError" role="alert"><span>{error}</span></div>}
          <div className="lc-field">
            <label htmlFor="resetNew">New password</label>
            <div className="lc-input">
              <input id="resetNew" type="password" required minLength={8} autoComplete="new-password" placeholder="8 or more characters" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <div className="lc-field">
            <label htmlFor="resetConfirm">Repeat the new password</label>
            <div className="lc-input">
              <input id="resetConfirm" type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          </div>
          <button id="resetSubmit" type="submit" disabled={busy} aria-busy={busy} className="lc-btn lc-btn-primary">
            {busy ? 'Saving…' : 'Change password'}
          </button>
          <Link to="/login" className="lc-link" style={{ alignSelf: 'flex-start', marginLeft: -6 }}>Back to sign in</Link>
        </form>
      )}
    </AuthShell>
  );
}
