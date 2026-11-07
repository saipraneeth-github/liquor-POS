import { MODE_COLOR, MODE_LABEL, MixBar } from './charts';
import { inr, inr2 } from './format';
import type { AttentionItem, LowStockRow, ManagerData, MixRow } from './types';

export const Icon = {
  alert: <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M8 6v4M8 11.6v.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>,
  check: <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 6.3 2.6 2.6L10 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  clock: <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M6 3.4V6l1.8 1.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>,
  chevron: <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m5 3 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
};

/** What needs a decision, ranked, each one a button that goes to the screen that fixes it. */
export function Attention({ items, onGo }: { items: AttentionItem[]; onGo: (item: AttentionItem) => void }) {
  if (items.length === 0) {
    return <div className="lc-attention" id="dashAttention"><span className="lc-att good" role="status">{Icon.check}<span>Nothing needs your attention right now</span></span></div>;
  }
  return (
    <div className="lc-attention" id="dashAttention" role="list" aria-label="Needs attention">
      {items.map((a) => (
        <button key={a.id} type="button" role="listitem" data-attention={a.id} className={`lc-att ${a.severity}`} onClick={() => onGo(a)}>
          {a.severity === 'good' ? Icon.check : Icon.alert}
          <span>{a.title} {a.detail && <small>{a.detail}</small>}</span>
          {Icon.chevron}
        </button>
      ))}
    </div>
  );
}

export function MixCard({ mix, title = 'Payment mix' }: { mix: MixRow[]; title?: string }) {
  const total = mix.reduce((a, m) => a + Number(m.total), 0);
  return (
    <div className="lc-card" id="dashMix">
      <h3>{title} <em className="lc-num">{inr(total)}</em></h3>
      <MixBar mix={mix} />
      <div className="lc-legend">
        {mix.map((m) => (
          <div key={m.mode}><i className="lc-sw" style={{ background: MODE_COLOR[m.mode] }} /><span className="nm">{MODE_LABEL[m.mode]}</span><span className="lc-num">{m.share}%</span></div>
        ))}
      </div>
    </div>
  );
}

export function ClosingCard({ closing, onGo }: { closing: ManagerData['closing']; onGo: (route: string) => void }) {
  const done = closing.steps.filter((s) => s.done).length;
  const allDone = done === closing.steps.length;
  return (
    <div className="lc-card" id="dashClosing">
      <h3>{closing.closedToday ? 'Today is closed' : 'Ready to close?'} <em className="lc-num">{done} of {closing.steps.length}</em></h3>
      <div className="lc-progress" style={{ marginBottom: 12 }}><i style={{ width: `${(done / closing.steps.length) * 100}%` }} /></div>
      <div className="lc-steps">
        {closing.steps.map((s) => (
          <button key={s.id} type="button" className={`lc-step ${s.done ? 'done' : 'todo'}`} data-step={s.id} onClick={() => !s.done && onGo(s.route)} disabled={s.done}>
            <span className="ico">{s.done ? Icon.check : Icon.clock}</span><span className="nm">{s.label}</span>
          </button>
        ))}
      </div>
      {!closing.closedToday && (
        <button type="button" id="dashStartClosing" className={`lc-btn ${allDone ? 'lc-btn-primary' : 'lc-btn-ghost'}`} style={{ marginTop: 14, width: '100%' }} onClick={() => onGo('/closing')}>
          Start day closing {Icon.chevron}
        </button>
      )}
    </div>
  );
}

export function TopSellers({ rows }: { rows: ManagerData['topSellers'] }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.sales)));
  return (
    <div className="lc-card" id="dashTopSellers">
      <h3>Top sellers today <em>units · sales</em></h3>
      {rows.length === 0 ? <div className="lc-empty" style={{ padding: 12 }}>Nothing sold yet today.</div> : rows.map((r) => (
        <div className="lc-hbar" key={r.name}>
          <span className="t" title={r.name}>{r.name}</span>
          <span className="track"><i style={{ width: `${(Number(r.sales) / max) * 100}%` }} /></span>
          <span className="lc-num fig">{r.units} · {inr(r.sales)}</span>
        </div>
      ))}
    </div>
  );
}

export function StockCard({ rows, count, onGo }: { rows: LowStockRow[]; count: number; onGo: (route: string) => void }) {
  return (
    <div className="lc-card" id="dashStock">
      <h3>Stock to watch <button type="button" className="lc-link" onClick={() => onGo('/inventory')}>Inventory</button></h3>
      {rows.length === 0 ? (
        <div className="lc-empty" style={{ padding: 12 }}>Every item is above its reorder level.</div>
      ) : (
        <div className="lc-list">
          {rows.map((r) => (
            <div className="lc-row" key={r.name}>
              <div className="grow"><div className="t" title={r.name}>{r.name}</div><div className="s">{r.quantity} left · reorder at {r.reorderLevel ?? 0}</div></div>
              <span className={`lc-pill ${r.quantity <= 0 ? 'bad' : 'warn'}`}>{r.quantity <= 0 ? 'Out' : 'Low'}</span>
            </div>
          ))}
          {count > rows.length && <div className="s" style={{ color: 'var(--muted)', fontSize: 12, paddingTop: 10 }}>and {count - rows.length} more</div>}
        </div>
      )}
    </div>
  );
}

export function ShiftCard({ shift, onGo }: { shift: NonNullable<ManagerData['myShift']>; onGo: (route: string) => void }) {
  const mix = shift.mix.filter((m) => Number(m.total) > 0);
  return (
    <div className="lc-card" id="dashShift">
      <h3>Your shift <em className="lc-num">{shift.bills} bill{shift.bills === 1 ? '' : 's'}</em></h3>
      <div className="lc-grid lc-g-2e">
        <div className="lc-kpi"><span className="label">Sales this shift</span><span className="value" id="dashShiftSales">{inr2(shift.sales)}</span>
          <span className="sub">{mix.length === 0 ? 'No sales yet' : mix.map((m) => `${MODE_LABEL[m.mode]} ${inr(m.total)}`).join(' · ')}</span></div>
        <div className="lc-kpi"><span className="label">Cash that should be in the drawer</span><span className="value" id="dashExpectedCash">{inr2(shift.expectedCash)}</span>
          <span className="sub">Opening {inr(shift.openingFloat)} + cash sales {inr(shift.mix.find((m) => m.mode === 'CASH')?.total ?? 0)}</span></div>
      </div>
      <div style={{ marginTop: 16 }}><MixBar mix={shift.mix} /></div>
      <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="lc-btn lc-btn-ghost" onClick={() => onGo('/shift')}>Count the drawer</button>
        <button type="button" className="lc-btn lc-btn-ghost" onClick={() => onGo('/shift')}>Close shift</button>
      </div>
    </div>
  );
}
