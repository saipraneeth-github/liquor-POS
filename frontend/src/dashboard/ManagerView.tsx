import { Delta, HourlyChart, Sparkline } from './charts';
import { duration, inr } from './format';
import { Attention, ClosingCard, MixCard, ShiftCard, StockCard, TopSellers } from './parts';
import type { AttentionItem, ManagerData } from './types';

/** The manager's day: what needs a decision, how sales compare with yesterday at this time, and the day-close checklist. */
export function ManagerView({ data, onGo, onAttention }: { data: ManagerData; onGo: (route: string) => void; onAttention: (a: AttentionItem) => void }) {
  const t = data.today;
  const upTo = data.today.hourly.slice(0, data.currentHour + 1);
  const first = Math.max(0, upTo.findIndex((v) => v > 0));
  const trend = upTo.slice(first);
  const hasSales = t.bills > 0;

  return (
    <>
      <Attention items={data.attention} onGo={onAttention} />

      <div className="lc-grid lc-g-kpi">
        <div className="lc-card lc-kpi">
          <span className="label">Sales so far today</span>
          <span className="value" id="dashSales">{inr(t.sales)}</span>
          <span className="sub">
            {t.vsYesterday.percent === null ? 'Nothing to compare with yet' : <><Delta percent={t.vsYesterday.percent} /> vs yesterday at this time</>}
          </span>
          <Sparkline values={trend} />
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Bills</span>
          <span className="value" id="dashBills">{t.bills}</span>
          <span className="sub">{hasSales ? <>Average {inr(t.averageBill)}</> : 'No sales yet'}</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">GST in today&apos;s sales</span>
          <span className="value" id="dashGst">{inr(t.gst)}</span>
          <span className="sub">Included in the sales figure</span>
        </div>
        <div className="lc-card lc-kpi">
          <span className="label">Tables open</span>
          <span className="value" id="dashTables">{data.tables.occupied} <small>of {data.tables.total}</small></span>
          <span className="sub">{data.tables.oldestOpenMinutes === null ? 'None open' : `Oldest open ${duration(data.tables.oldestOpenMinutes)}`}</span>
          <div className="lc-tables" role="img" aria-label={`${data.tables.occupied} of ${data.tables.total} tables open`}>
            {Array.from({ length: Math.min(data.tables.total, 16) }, (_, i) => <i key={i} className={i < data.tables.occupied ? 'on' : ''} />)}
          </div>
        </div>
      </div>

      <div className="lc-grid lc-g-2">
        <div className="lc-card" id="dashHourly">
          <h3>Sales by hour <em>today against yesterday ({inr(data.yesterday.sales)} in all)</em></h3>
          {hasSales || Number(data.yesterday.sales) > 0 ? (
            <>
              <HourlyChart today={t.hourly} yesterday={data.yesterday.hourly} currentHour={data.currentHour} />
              <div className="lc-chart-legend">
                <span><i className="lc-sw" style={{ background: 'var(--accent)' }} />Today</span>
                <span><i className="lc-sw" style={{ background: 'transparent', border: '1.5px dashed var(--accent)' }} />This hour, still filling</span>
                <span><i className="lc-sw" style={{ background: 'var(--muted)', height: 3, borderRadius: 2 }} />Yesterday</span>
              </div>
            </>
          ) : (
            <div className="lc-empty"><b>No sales yet today</b><span>The hourly picture appears as bills come in.</span>
              <button type="button" className="lc-btn lc-btn-primary" onClick={() => onGo('/pos')}>Ring the first bill</button></div>
          )}
        </div>
        <div className="lc-stack">
          <MixCard mix={t.mix} />
          <ClosingCard closing={data.closing} onGo={onGo} />
        </div>
      </div>

      {data.myShift && <ShiftCard shift={data.myShift} onGo={onGo} />}

      <div className="lc-grid lc-g-2e">
        <TopSellers rows={data.topSellers} />
        <StockCard rows={data.lowStock} count={data.lowStockCount} onGo={onGo} />
      </div>
    </>
  );
}
