import { Delta } from './charts';
import { inr, lakh } from './format';
import { Attention } from './parts';
import type { AttentionItem, OwnerData } from './types';

const AGING_COLOR = ['var(--s-upi)', 'var(--s-card)', 'var(--warn)', 'var(--bad)'];

/** The owner's view across every outlet: each against its own yesterday, the month so far, and the money still owed. */
export function OwnerView({ data, onAttention, onOpenBranch }: {
  data: OwnerData; onAttention: (a: AttentionItem) => void; onOpenBranch: (branchId: string) => void;
}) {
  const max = Math.max(1, ...data.branches.flatMap((b) => [Number(b.sales), Number(b.salesSameTimeYesterday)]));
  const aging = data.khata.buckets;
  const owed = Number(data.khata.owed);
  const m = data.month;
  const lastTotal = Number(m.lastMonthTotal);
  const barMax = Math.max(Number(m.sales), lastTotal, 1);

  return (
    <>
      <Attention items={data.attention} onGo={onAttention} />

      <div className="lc-grid lc-g-kpi">
        <div className="lc-card lc-kpi">
          <span className="label">Sales today, all outlets</span>
          <span className="value" id="dashSales">{inr(data.totals.sales)}</span>
          <span className="sub">{data.totals.percent === null ? 'Nothing to compare with yet' : <><Delta percent={data.totals.percent} /> vs yesterday at this time</>}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Month so far</span>
          <span className="value" id="dashMonth">{lakh(m.sales)}</span>
          <span className="sub">{m.percent === null ? 'No sales in the same days last month' : <><Delta percent={m.percent} /> vs the same days last month</>}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Khata owed to you</span>
          <span className="value" id="dashKhata">{owed >= 100000 ? lakh(owed) : inr(owed)}</span>
          <span className="sub">{Number(data.khata.over30) > 0 ? `${inr(data.khata.over30)} is over 30 days` : `${data.khata.customers} customer${data.khata.customers === 1 ? '' : 's'}, none overdue`}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Bank books up to date</span>
          <span className="value">{data.bank.reconciled} <small>of {data.bank.outlets}</small></span>
          <span className="sub">{data.bank.outlets === 0 ? 'No bank account added yet' : data.bank.reconciled === data.bank.outlets ? 'All outlets reconciled' : 'Some outlets are behind'}</span>
        </div>
      </div>

      <div className="lc-grid lc-g-2">
        <div className="lc-card" id="dashBranches">
          <h3>Outlets <em>sales today · yesterday at this time marked</em></h3>
          {data.branches.map((b) => (
            <div className="lc-hbar" key={b.id}>
              <button type="button" className="lc-link t" style={{ textAlign: 'left', color: 'var(--text)' }} onClick={() => onOpenBranch(b.id)} title={`Open ${b.name}`}>{b.name}</button>
              <span className="track"><i style={{ width: `${(Number(b.sales) / max) * 100}%` }} /><b style={{ left: `${(Number(b.salesSameTimeYesterday) / max) * 100}%` }} title="Yesterday at this time" /></span>
              <span className="lc-num fig">{inr(b.sales)} <Delta percent={b.percent} /></span>
            </div>
          ))}
          <div className="lc-chart-legend">
            <span><i className="lc-sw" style={{ background: 'var(--accent)' }} />Today</span>
            <span><i className="lc-sw" style={{ background: 'var(--text)', width: 2 }} />Yesterday at this time</span>
          </div>
        </div>

        <div className="lc-card" id="dashMonthCard">
          <h3>Month against last month</h3>
          <div className="lc-kpi">
            <span className="value">{m.percentOfLastMonth === null ? '–' : `${Math.round(m.percentOfLastMonth)}%`}</span>
            <span className="sub">{m.percentOfLastMonth === null ? 'No sales last month to compare with' : 'of what you sold in all of last month'}</span>
          </div>
          <div className="lc-progress accent" style={{ marginTop: 14, height: 12 }} role="img" aria-label="Month so far against last month">
            <i style={{ width: `${(Number(m.sales) / barMax) * 100}%` }} />
            {lastTotal > 0 && <span style={{ position: 'absolute', top: -4, bottom: -4, width: 2, background: 'var(--text)', left: `${(lastTotal / barMax) * 100}%`, transform: 'translateX(-1px)' }} title="All of last month" />}
          </div>
          <p style={{ margin: '10px 0 0', color: 'var(--muted)', fontSize: 12 }}>
            {inr(m.sales)} so far. The line marks last month in full ({inr(m.lastMonthTotal)}); the same days last month came to {inr(m.sameDaysLastMonth)}.
          </p>
        </div>
      </div>

      <div className="lc-card" id="dashAging">
        <h3>Khata by age <em className="lc-num">{inr(data.khata.owed)}</em></h3>
        {owed === 0 ? (
          <div className="lc-empty" style={{ padding: 12 }}>Nobody owes you anything.</div>
        ) : (
          <>
            <div className="lc-aging" role="img" aria-label={aging.map((a) => `${a.label} ${inr(a.amount)}`).join(', ')}>
              {aging.filter((a) => Number(a.amount) > 0).map((a) => <span key={a.key} style={{ flex: Number(a.amount), background: AGING_COLOR[aging.indexOf(a)] }}>{Math.round((Number(a.amount) / owed) * 100)}%</span>)}
            </div>
            <div className="lc-legend" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              {aging.map((a, i) => <div key={a.key}><i className="lc-sw" style={{ background: AGING_COLOR[i] }} /><span className="nm">{a.label}</span><span className="lc-num">{inr(a.amount)}</span></div>)}
            </div>
          </>
        )}
      </div>
    </>
  );
}
