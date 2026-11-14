import { Delta } from '../dashboard/charts';
import { inr, lakh } from '../dashboard/format';

export type QueueKey = 'trialEnding' | 'overdue' | 'quiet' | 'suspended';

export interface PlatformDash {
  asOf: string;
  kpis: {
    mrr: number; payingTenants: number; trialTenants: number; outstanding: string; outstandingCount: number;
    branches: number; staff: number; sales30d: string; salesChangePercent: number | null;
  };
  plans: { plan: string; name: string; price: string; count: number }[];
  revenueByMonth: { month: string; standard: number; pro: number }[];
  funnel: { signedUp: number; billed: number; paying: number };
  queue: Record<QueueKey, { count: number; ids: string[] }>;
}

const QUEUE: { key: QueueKey; tone: 'bad' | 'warn' | 'good'; label: string; hint: string }[] = [
  { key: 'trialEnding', tone: 'warn', label: 'Trials ending soon', hint: 'Ending within 4 days, or already ended' },
  { key: 'overdue', tone: 'bad', label: 'Payments overdue', hint: 'Paid-until date has passed' },
  { key: 'quiet', tone: 'warn', label: 'No bills in 7+ days', hint: 'Churn risk: help them get going' },
  { key: 'suspended', tone: 'good', label: 'Suspended', hint: 'Reactivate when they pay' },
];

const KNOWN_COLOR: Record<string, string> = { TRIAL: 'var(--muted)', STANDARD: 'var(--accent)', PRO: 'var(--s-card)' };
const EXTRA_COLORS = ['var(--s-upi, #7c5cff)', 'var(--s-cash, #e08a1e)', 'var(--s-credit, #d6457a)', '#0e9aa7'];
/** The three original plans keep their colours; any plan added later gets the next free one. */
const planColor = (code: string, index: number) => KNOWN_COLOR[code] ?? EXTRA_COLORS[index % EXTRA_COLORS.length];

const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
};

/** Smallest "round" top for the axis that fits the data, so the labels are real values the bars can reach. */
function niceMax(v: number): number {
  if (v <= 0) return 10_000;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return 10 * step;
}

const shortInr = (v: number) => (v === 0 ? '0' : v >= 100_000 ? `₹${+(v / 100_000).toFixed(1)}L` : v >= 1000 ? `₹${+(v / 1000).toFixed(1)}k` : `₹${v}`);

function RevenueChart({ rows }: { rows: PlatformDash['revenueByMonth'] }) {
  const W = 560, H = 210, L = 46, B = 26, T = 18;
  const top = niceMax(Math.max(...rows.map((r) => r.standard + r.pro)));
  const plotH = H - B - T;
  const step = (W - L - 8) / rows.length;
  const bw = Math.min(46, step * 0.62);
  const y = (v: number) => H - B - (plotH * v) / top;
  return (
    <svg className="lc-chart" viewBox={`0 0 ${W} ${H}`} role="img" id="platformRevenueChart"
      aria-label={`Subscription money collected per month: ${rows.map((r) => `${monthLabel(r.month)} ${inr(r.standard + r.pro)}`).join(', ')}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line className="grid-l" x1={L} x2={W - 6} y1={y(top * f)} y2={y(top * f)} />
          <text x={L - 8} y={y(top * f) + 4} textAnchor="end">{shortInr(top * f)}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const x = L + step * i + (step - bw) / 2;
        const total = r.standard + r.pro;
        return (
          <g key={r.month}>
            {r.standard > 0 && <rect x={x} y={y(r.standard)} width={bw} height={H - B - y(r.standard)} fill="var(--accent)" rx="3" />}
            {r.pro > 0 && <rect x={x} y={y(total)} width={bw} height={y(r.standard) - y(total)} fill="var(--s-card)" rx="3" />}
            {total > 0 && <text x={x + bw / 2} y={y(total) - 5} textAnchor="middle" style={{ fill: 'var(--text)' }}>{shortInr(total)}</text>}
            <text x={x + bw / 2} y={H - 8} textAnchor="middle">{monthLabel(r.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** The Super Admin's first screen: what needs doing, what the business earns, and where tenants stand. */
export function PlatformInsights({ data, active, onPick }: { data: PlatformDash; active: QueueKey | ''; onPick: (k: QueueKey | '') => void }) {
  const k = data.kpis;
  const totalPlans = Math.max(1, data.plans.reduce((s, p) => s + p.count, 0));
  const hasRevenue = data.revenueByMonth.some((r) => r.standard + r.pro > 0);
  const f = data.funnel;
  const nothingToDo = QUEUE.every((q) => data.queue[q.key].count === 0);

  return (
    <>
      <section aria-labelledby="platformQueueTitle" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 id="platformQueueTitle" style={{ margin: 0, font: '700 15px var(--font-display)' }}>Needs action today</h2>
        {nothingToDo ? (
          <div className="lc-attention"><span className="lc-att good" id="platformQueueClear">All clear: no trials ending, nothing overdue, nobody gone quiet.</span></div>
        ) : null}
        <div className="lc-queue" id="platformQueue">
          {QUEUE.map((q) => {
            const n = data.queue[q.key].count;
            return (
              <button key={q.key} type="button" className={`lc-q ${n === 0 ? 'zero' : q.tone}`} data-queue={q.key}
                aria-pressed={active === q.key} disabled={n === 0} onClick={() => onPick(active === q.key ? '' : q.key)}>
                <b className="lc-num">{n}</b>
                <strong>{q.label}</strong>
                <span>{q.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="lc-grid lc-g-3" id="platformKpis">
        <div className="lc-card lc-kpi">
          <span className="label">Monthly recurring revenue</span>
          <span className="value" id="kpiMrr">{inr(k.mrr)}</span>
          <span className="sub">From {k.payingTenants} paying {k.payingTenants === 1 ? 'business' : 'businesses'} in good standing</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Paying businesses</span>
          <span className="value" id="kpiPaying">{k.payingTenants} <small>of {k.payingTenants + k.trialTenants + data.queue.suspended.count}</small></span>
          <span className="sub">{k.trialTenants} on trial · {data.queue.suspended.count} suspended</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Waiting to be paid</span>
          <span className="value" id="kpiOutstanding">{inr(k.outstanding)}</span>
          <span className="sub">{k.outstandingCount === 0 ? 'No unpaid invoices' : `${k.outstandingCount} unpaid invoice${k.outstandingCount === 1 ? '' : 's'}`}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Outlets live</span>
          <span className="value" id="kpiOutlets">{k.branches}</span>
          <span className="sub">{k.staff} active staff accounts</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Sales processed, 30 days</span>
          <span className="value" id="kpiSales">{Number(k.sales30d) >= 100_000 ? lakh(k.sales30d) : inr(k.sales30d)}</span>
          <span className="sub">{k.salesChangePercent === null ? 'No earlier month to compare with' : <><Delta percent={k.salesChangePercent} /> on the 30 days before</>}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">New in the last 30 days</span>
          <span className="value" id="kpiFunnel">{f.signedUp}</span>
          <span className="sub">{f.billed} have billed · {f.paying} now paying</span>
        </div>
      </div>

      <div className="lc-grid lc-g-2">
        <div className="lc-card" id="platformRevenue">
          <h3>Subscription money collected <em>by the month it was paid</em></h3>
          {hasRevenue ? (
            <>
              <RevenueChart rows={data.revenueByMonth} />
              <div className="lc-chart-legend">
                <span><i className="lc-sw" style={{ background: 'var(--accent)' }} />Standard</span>
                <span><i className="lc-sw" style={{ background: 'var(--s-card)' }} />Pro</span>
              </div>
            </>
          ) : (
            <div className="lc-empty"><b>No payments recorded yet</b><span>Collected subscription money appears here once an invoice is marked paid.</span></div>
          )}
        </div>
        <div className="lc-card" id="platformPlans">
          <h3>Plans <em>{(() => { const n = data.plans.reduce((s, p) => s + p.count, 0); return n === 0 ? 'no businesses yet' : `${n} ${n === 1 ? 'business' : 'businesses'}`; })()}</em></h3>
          <div className="lc-mixbar" role="img" aria-label={data.plans.map((p) => `${p.name} ${p.count}`).join(', ')}>
            {data.plans.map((p, i) => ({ p, i })).filter(({ p }) => p.count > 0).map(({ p, i }) => <span key={p.plan} style={{ width: `${(p.count / totalPlans) * 100}%`, background: planColor(p.plan, i) }} />)}
          </div>
          <div className="lc-legend" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
            {data.plans.map((p, i) => ({ p, i })).reverse().map(({ p, i }) => (
              <div key={p.plan}>
                <i className="lc-sw" style={{ background: planColor(p.plan, i) }} />
                <span>{p.name} <span className="nm">{Number(p.price) === 0 ? 'free' : `${inr(p.price)}/month`}</span></span>
                <span className="lc-num">{p.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function healthTone(score: number): 'good' | 'warn' | 'bad' {
  return score >= 75 ? 'good' : score >= 45 ? 'warn' : 'bad';
}
