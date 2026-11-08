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
          <h3>Monthly Sales <em>month by month sales across all outlets</em></h3>
          <div style={{ marginTop: 14 }}>
            {(m.history && m.history.length > 0 ? m.history : [
              { month: 'prev', label: 'Last Month', sales: m.lastMonthTotal },
              { month: 'curr', label: 'This Month', sales: m.sales },
            ]).map((h) => {
              const histMax = Math.max(1, ...(m.history?.map((x) => Number(x.sales)) ?? [Number(m.sales), Number(m.lastMonthTotal)]));
              const pct = Math.min(100, Math.max(0, (Number(h.sales) / histMax) * 100));
              const isCurrent = h.month === m.history?.[m.history.length - 1]?.month;
              return (
                <div className="lc-hbar" key={h.month}>
                  <span className="t" style={{ fontWeight: 600, minWidth: 44 }}>{h.label}</span>
                  <span className="track">
                    <i style={{ width: `${pct}%`, background: isCurrent ? 'var(--accent)' : 'var(--muted)' }} />
                  </span>
                  <span className="lc-num fig" style={{ fontWeight: 600 }}>{inr(h.sales)}</span>
                </div>
              );
            })}
          </div>
          <div className="lc-chart-legend" style={{ marginTop: 14 }}>
            <span><i className="lc-sw" style={{ background: 'var(--accent)' }} />Current Month (MTD)</span>
            <span><i className="lc-sw" style={{ background: 'var(--muted)' }} />Previous Months</span>
          </div>
        </div>
      </div>
    </>
  );
}
