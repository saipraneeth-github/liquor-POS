import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { ApiError, api } from '../api/client';
import { useAuth, type User } from './AuthProvider';
import { useTheme } from '../context/ThemeContext';
import { errorMessage } from '../lib/print';
import { Mark, Shelf } from './AuthShell';

// Demo accounts (one-click sign-in, prefilled credentials) exist only for local dev and deliberate demo
// deployments. A production build must never advertise known logins, so it needs an explicit opt-in.
const SHOW_DEMO_LOGINS = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_LOGINS === 'true';

const EMAIL_KEY = 'lc_remember_email';
const WORKPLACE_KEY = 'lc_last_workplace';
const read = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

type Server = 'checking' | 'up' | 'down';
type Problem =
  | { kind: 'wrong'; message: string; attemptsLeft: number | null }
  | { kind: 'locked'; message: string; until: number }
  | { kind: 'down'; message: string }
  | { kind: 'other'; message: string };

const AlertIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M8 6v4M8 11.6v.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
);

export function Login() {
  const remembered = read(EMAIL_KEY);
  const [email, setEmail] = useState(remembered || (SHOW_DEMO_LOGINS ? 'cashier@liquor.com' : ''));
  const [password, setPassword] = useState(SHOW_DEMO_LOGINS ? 'Password@123' : '');
  const [showPw, setShowPw] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [remember, setRemember] = useState<boolean>(true);   // on by default; unticking forgets the saved email at the next sign-in
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<Server>('checking');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const { login, error: contextError } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const workplace = read(WORKPLACE_KEY);

  // Is the server reachable? Checked now and every 20 seconds, so a failed sign-in is never a mystery.
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const ctl = new AbortController();
        const timer = window.setTimeout(() => ctl.abort(), 4000);
        const res = await fetch('/api/v1/health', { cache: 'no-store', signal: ctl.signal });
        window.clearTimeout(timer);
        if (alive) setServer(res.ok ? 'up' : 'down');
      } catch { if (alive) setServer('down'); }
    };
    void ping();
    const id = window.setInterval(ping, 20_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Lockout countdown
  const lockedUntil = problem?.kind === 'locked' ? problem.until : 0;
  useEffect(() => {
    if (!lockedUntil) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setProblem(null);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [lockedUntil]);

  const locked = problem?.kind === 'locked' && secondsLeft > 0;
  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

  const capsCheck = (e: React.KeyboardEvent) => setCapsOn(e.getModifierState?.('CapsLock') ?? false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    setProblem(null);
    setBusy(true);
    try {
      const { token } = await api.post<{ token: string }>('/auth/login', { email, password });
      localStorage.setItem('token', token);
      const freshUser = await api.get<User>('/me');
      write(EMAIL_KEY, remember ? email.trim() : null);
      login(token, freshUser);
      // Best effort: remember the shop's name so the next sign-in screen can greet it
      api.get<Array<{ name: string }>>('/branches').then((b) => { if (b[0]?.name) write(WORKPLACE_KEY, b[0].name); }).catch(() => undefined);
      navigate(freshUser.role === 'owner' && !freshUser.syndicateId ? '/platform' : '/');
    } catch (err: unknown) {
      localStorage.removeItem('token');
      if (err instanceof ApiError && err.status === 429) {
        const secs = Number(err.data?.retryAfterSeconds) || 900;
        setProblem({ kind: 'locked', message: err.message, until: Date.now() + secs * 1000 });
      } else if (err instanceof ApiError && err.status === 401) {
        const left = typeof err.data?.attemptsLeft === 'number' ? err.data.attemptsLeft : null;
        setProblem({ kind: 'wrong', message: err.message, attemptsLeft: left });
      } else if (err instanceof TypeError) {
        setServer('down');
        setProblem({ kind: 'down', message: 'Cannot reach the server.' });
      } else {
        setProblem({ kind: 'other', message: errorMessage(err) || 'Sign in failed' });
      }
    } finally {
      setBusy(false);
    }
  };

  const loginAs = (role: string) => {
    setEmail(role === 'superadmin' ? 'superadmin@liquor.com' : `${role}@liquor.com`);
    setPassword('Password@123');
  };

  const shownError = problem ? null : (contextError || null);

  return (
    <div className="lc" id="loginPage">
      <div className="lc-login">
        <div className="lc-login-brand">
          <div className="lc-brandmark"><Mark /><div><b>Liquor Counter</b><small>Billing, stock and books</small></div></div>
          <div>
            <h2>{workplace || 'Counter, stock and books in one place'}</h2>
            <p>{workplace ? 'Welcome back. Sign in to start your shift.' : 'Sign in to start your shift.'}</p>
          </div>
          <div className="lc-brand-foot">
            <span className="lc-chip" id="loginServerStatus" data-server={server}>
              <span className={`lc-dot ${server === 'down' ? 'bad' : server === 'checking' ? 'wait' : ''}`} />
              {server === 'up' ? 'Server reachable' : server === 'down' ? 'Server not reachable' : 'Checking the server'}
            </span>
            <span className="lc-chip">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          </div>
          <Shelf />
        </div>

        <div className="lc-login-form-wrap">
          <button id="loginThemeBtn" type="button" className="lc-theme-btn" onClick={toggleTheme} aria-label="Toggle dark/light theme" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>

          <form className="lc-login-form" onSubmit={handleSubmit} noValidate>
            <h1>Sign in</h1>
            <p className="lead">Use the email your manager gave you.</p>

            {(problem || shownError) && (
              <div id="loginError" role="alert" className={`lc-alert ${problem?.kind === 'down' ? 'warn' : 'bad'}`}>
                {AlertIcon}
                <span>
                  {problem?.kind === 'wrong' && (
                    <><b>That email and password do not match.</b>{' '}
                      {problem.attemptsLeft === null ? '' : problem.attemptsLeft > 0
                        ? `${problem.attemptsLeft} ${problem.attemptsLeft === 1 ? 'try' : 'tries'} left before this device is locked out for 15 minutes.`
                        : 'This device is now locked out for 15 minutes.'}</>
                  )}
                  {problem?.kind === 'locked' && (
                    <><b>Too many wrong tries.</b> Try again in <span className="lc-num" id="loginLockTimer">{mmss}</span>, or ask your manager to reset your password.</>
                  )}
                  {problem?.kind === 'down' && (
                    <><b>Cannot reach the server.</b> Check the shop router. Once you are signed in you can still ring bills; they send when the connection returns.</>
                  )}
                  {problem?.kind === 'other' && problem.message}
                  {!problem && shownError}
                </span>
              </div>
            )}

            <div className="lc-field">
              <label htmlFor="loginEmail">Email</label>
              <div className="lc-input">
                {/* The lock is per account on this device, so changing the e-mail lifts the message and lets the server decide */}
                <input id="loginEmail" type="email" autoComplete="username" inputMode="email" value={email} required aria-required="true"
                  onChange={(e) => { setEmail(e.target.value); if (problem?.kind === 'locked') setProblem(null); }} />
              </div>
            </div>

            <div className="lc-field">
              <label htmlFor="loginPass">Password</label>
              <div className="lc-input">
                <input
                  id="loginPass" type={showPw ? 'text' : 'password'} autoComplete="current-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} onKeyDown={capsCheck} onKeyUp={capsCheck} onBlur={() => setCapsOn(false)}
                  required aria-required="true" disabled={locked}
                />
                <button type="button" id="loginShowPw" aria-pressed={showPw} aria-controls="loginPass" onClick={() => setShowPw((v) => !v)}>{showPw ? 'Hide' : 'Show'}</button>
              </div>
              <div className="lc-hint" id="loginCaps" aria-live="polite">{capsOn && <>{AlertIcon}Caps Lock is on</>}</div>
            </div>

            <div className="lc-form-row">
              <label className="lc-check"><input id="loginRemember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my email</label>
              <Link to="/forgot-password" id="forgotLink" className="lc-link">Forgot password?</Link>
            </div>

            <button type="submit" id="loginBtn" className="lc-btn lc-btn-primary" disabled={busy || locked} aria-busy={busy}>
              {busy ? 'Signing in…' : locked ? `Locked for ${mmss}` : 'Sign in'}
            </button>

            {SHOW_DEMO_LOGINS && (
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>Demo accounts</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {[['superadmin', 'Super Admin'], ['owner', 'Admin'], ['manager', 'Manager'], ['cashier', 'Cashier'], ['steward', 'Steward']].map(([role, label]) => (
                    <button key={role} type="button" className="lc-btn lc-btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => loginAs(role)}>{label}</button>
                  ))}
                </div>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
