import { hourLabel, inr } from './format';
import type { MixRow } from './types';

export const MODE_COLOR: Record<MixRow['mode'], string> = {
  CASH: 'var(--s-cash)', UPI: 'var(--s-upi)', CARD: 'var(--s-card)', CREDIT: 'var(--s-khata)',
};
export const MODE_LABEL: Record<MixRow['mode'], string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'Khata' };

/** Up/down pill against a comparison; "nothing to compare" is said in words instead of a made-up 0%. */
export function Delta({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="lc-delta flat">new</span>;
  const up = percent >= 0;
  return (
    <span className={`lc-delta ${percent === 0 ? 'flat' : up ? 'up' : 'down'}`}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">{up ? <path d="M5 1.5 9 8H1z" fill="currentColor" /> : <path d="M5 8.5 1 2h8z" fill="currentColor" />}</svg>
      {Math.abs(percent).toFixed(1)}%
    </span>
  );
}

/** A trend line with its area and an emphasised end point. The dot is HTML so it stays round while the line stretches. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 100, h = 34;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 4) + 2, h - 4 - ((v - min) / span) * (h - 10)] as const);
  const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <div className="lc-spark-wrap" aria-hidden="true">
      <svg className="lc-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <polygon className="area" points={`2,${h} ${line} ${w - 2},${h}`} />
        <polyline className="line" points={line} />
      </svg>
      <i className="lc-spark-end" style={{ left: `${(last[0] / w) * 100}%`, top: `${(last[1] / h) * 100}%` }} />
    </div>
  );
}

export function MixBar({ mix }: { mix: MixRow[] }) {
  const total = mix.reduce((a, m) => a + Number(m.total), 0);
  return (
    <div className="lc-mixbar" role="img" aria-label={total === 0 ? 'No sales yet' : mix.map((m) => `${MODE_LABEL[m.mode]} ${m.share}%`).join(', ')}>
      {mix.filter((m) => Number(m.total) > 0).map((m) => <span key={m.mode} style={{ flex: Number(m.total), background: MODE_COLOR[m.mode] }} />)}
    </div>
  );
}

/** The smallest tidy step that needs five gridlines or fewer, so the top of the scale sits just above the data. */
function niceStep(max: number): number {
  const base = Math.pow(10, Math.floor(Math.log10(max)) - 1);
  for (const m of [1, 2, 2.5, 5, 10, 20]) if (Math.ceil(max / (base * m)) <= 5) return base * m;
  return base * 20;
}

/** Sales by hour: bars for today (the current hour dashed, still filling), a dashed line for yesterday. Drawn to one scale. */
export function HourlyChart({ today, yesterday, currentHour }: { today: number[]; yesterday: number[]; currentHour: number }) {
  const active = [...today, ...yesterday].map((v, i) => (v > 0 ? i % 24 : -1)).filter((i) => i >= 0);
  let from = Math.max(0, Math.min(currentHour, ...(active.length ? active : [currentHour])) - 1);
  let to = Math.min(23, Math.max(currentHour, ...(active.length ? active : [currentHour])) + 1);
  while (to - from < 7) { if (from > 0) from--; if (to - from < 7 && to < 23) to++; if (from === 0 && to === 23) break; }
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);

  const W = 680, H = 250, pl = 46, pr = 10, pt = 12, pb = 28, iw = W - pl - pr, ih = H - pt - pb;
  const max = Math.max(1, ...hours.map((h) => Math.max(today[h] ?? 0, yesterday[h] ?? 0)));
  const step = niceStep(max), top = Math.ceil(max / step) * step;
  const y = (v: number) => pt + ih - (v / top) * ih;
  const slot = iw / hours.length, bw = slot * 0.58, x = (i: number) => pl + slot * i + slot / 2;
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const peak = hours.reduce((best, h) => ((today[h] ?? 0) > (today[best] ?? 0) ? h : best), hours[0]);
  const summary = `Sales by hour. Today's busiest hour is ${hourLabel(peak)} with ${inr(today[peak] ?? 0)}.`;

  return (
    <div role="img" aria-label={summary}>
      <svg className="lc-chart" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-l" x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} />
            <text x={pl - 8} y={y(t) + 3.5} textAnchor="end">{t === 0 ? '0' : `₹${t >= 1000 ? `${t / 1000}k` : t}`}</text>
          </g>
        ))}
        {hours.map((h, i) => {
          const v = h <= currentHour ? (today[h] ?? 0) : 0;
          const live = h === currentHour;
          return v > 0 ? <rect key={h} className={`bar${live ? ' now' : ''}`} x={x(i) - bw / 2} y={y(v)} width={bw} height={pt + ih - y(v)} rx={3} /> : null;
        })}
        <polyline className="prev" points={hours.map((h, i) => `${x(i)},${y(yesterday[h] ?? 0)}`).join(' ')} />
        {hours.map((h, i) => <circle key={h} className="prev-dot" cx={x(i)} cy={y(yesterday[h] ?? 0)} r={2.2} />)}
        {hours.map((h, i) => <text key={h} x={x(i)} y={H - 8} textAnchor="middle">{hourLabel(h)}</text>)}
      </svg>
    </div>
  );
}
