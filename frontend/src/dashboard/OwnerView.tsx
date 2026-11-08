import { Delta } from './charts';
import { inr, lakh } from './format';
import { Attention } from './parts';
import type { AttentionItem, OwnerData } from './types';

/** The owner's view across every outlet: each against its own yesterday, the month so far, and bank reconciliation. */
export function OwnerView({ data, onAttention, onOpenBranch }: {
  data: OwnerData; onAttention: (a: AttentionItem) => void; onOpenBranch: (branchId: string) => void;
}) {
  const max = Math.max(1, ...data.branches.flatMap((b) => [Number(b.sales), Number(b.salesSameTimeYesterday)]));
  const m = data.month;

  return (
    <>
      <Attention items={data.attention} onGo={onAttention} />

      <div className="lc-grid lc-g-kpi">
        <div className="lc-card lc-kpi">
          <span className="label">Total Sheet Revenue</span>
          <span className="value" id="dashSales">{inr(data.totals.sheetRevenue ?? data.totals.sales)}</span>
          <span className="sub">{data.totals.percent === null ? 'Synced with Stock Reconciliation' : <><Delta percent={data.totals.percent} /> vs yesterday at this time</>}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Total Bottles Sold</span>
          <span className="value" id="dashBottles">{data.totals.totalBottlesSold ?? 0} <small>bottles</small></span>
          <span className="sub">Physical stock present: {data.totals.physicalStockPresent ?? 0} bottles</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Month so far</span>
          <span className="value" id="dashMonth">{lakh(m.sales)}</span>
          <span className="sub">{m.percent === null ? 'Current period sales' : <><Delta percent={m.percent} /> vs same period last month</>}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Bank books up to date</span>
          <span className="value">{data.bank.reconciled} <small>of {data.bank.outlets}</small></span>
          <span className="sub">{data.bank.outlets === 0 ? 'No bank account added yet' : data.bank.reconciled === data.bank.outlets ? 'All outlets reconciled & matched' : 'Statements pending reconciliation'}</span>
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
          <h3>Monthly Sales</h3>
          <div className="lc-kpi">
            <span className="value">{inr(m.sales)}</span>
            <span className="sub">Month-to-date total revenue</span>
          </div>
          <div className="lc-progress accent" style={{ marginTop: 14, height: 10 }} role="img" aria-label="Month to date sales">
            <i style={{ width: '100%' }} />
          </div>
          <p style={{ margin: '14px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Current month recorded revenue across all outlets: <b style={{ color: 'var(--text)' }}>{inr(m.sales)}</b>.
          </p>
        </div>
      </div>
    </>
  );
}
