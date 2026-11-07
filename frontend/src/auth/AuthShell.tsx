import type { ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export function Mark() {
  return (
    <svg className="lc-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0E2A21" stroke="#2C5A49" strokeWidth="1" />
      <path d="M13 5h6v4.6c0 1.2.8 2 1.7 3.2 1 1.3 1.3 2.6 1.3 4V26a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 10 26v-9.2c0-1.4.3-2.7 1.3-4 .9-1.2 1.7-2 1.7-3.2z" fill="#C7952E" />
      <rect x="10" y="18" width="12" height="5.5" fill="#0E2A21" opacity=".35" />
    </svg>
  );
}

/** A quiet shelf of bottles along the bottom of the brand panel. Decorative only. */
export function Shelf() {
  const xs = [10, 62, 112, 170, 222, 270, 330, 384, 440, 492, 548, 600];
  const hs = [92, 118, 80, 128, 100, 112, 86, 124, 96, 116, 82, 106];
  return (
    <svg className="lc-shelf" viewBox="0 0 640 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      {xs.map((bx, i) => {
        const h = hs[i], w = 26 + (i % 3) * 6;
        return (
          <g key={bx}>
            <rect x={bx + w / 2 - 5} y={150 - 14 - h} width={10} height={h * 0.34} rx={3} />
            <rect x={bx} y={150 - 14 - h * 0.66} width={w} height={h * 0.66} rx={7} />
            {i % 4 === 1 && <rect className="hl" x={bx + 4} y={150 - 14 - h * 0.42} width={w - 8} height={14} rx={2} />}
          </g>
        );
      })}
      <rect className="plank" x={0} y={136} width={640} height={14} />
    </svg>
  );
}

/** The sign-in screen's two-panel frame, for the other public screens (forgot and reset password). */
export function AuthShell({ id, heading, text, children }: { id: string; heading: string; text: string; children: ReactNode }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <div className="lc" id={id}>
      <div className="lc-login">
        <div className="lc-login-brand">
          <div className="lc-brandmark"><Mark /><div><b>Liquor Counter</b><small>Billing, stock and books</small></div></div>
          <div>
            <h2>{heading}</h2>
            <p>{text}</p>
          </div>
          <Shelf />
        </div>
        {/* These forms are short, so centring them exactly makes them look pushed down: sit them a little above the middle */}
        <div className="lc-login-form-wrap" style={{ paddingBottom: 'max(32px, 14vh)' }}>
          <button type="button" className="lc-theme-btn" onClick={toggleTheme} aria-label="Toggle dark/light theme" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
          <div className="lc-login-form">{children}</div>
        </div>
      </div>
    </div>
  );
}
