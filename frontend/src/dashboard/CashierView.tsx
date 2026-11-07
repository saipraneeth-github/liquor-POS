import { clock, inr2 } from './format';
import { Icon, Attention, ShiftCard, StockCard } from './parts';
import type { AttentionItem, CashierData } from './types';

/** A cashier's day: the till, their own shift and bills. Branch revenue and the books are not shown to them. */
export function CashierView({ data, firstName, onGo, onAttention }: {
  data: CashierData; firstName: string; onGo: (route: string) => void; onAttention: (a: AttentionItem) => void;
}) {
  return (
    <>
      <Attention items={data.attention} onGo={onAttention} />
      <div className="lc-grid lc-g-2">
        <div className="lc-stack">
          {data.myShift ? (
            <>
              <p className="lc-updated" style={{ margin: 0 }}>{data.myShift.terminalName} · opened {clock(data.myShift.openedAt)}</p>
              <ShiftCard shift={data.myShift} onGo={onGo} />
            </>
          ) : (
            <div className="lc-card" id="dashNoShift">
              <div className="lc-empty">
                <b>No shift open, {firstName}</b>
                <span>Open a shift on your counter to start tracking the drawer.</span>
                <button type="button" className="lc-btn lc-btn-primary" onClick={() => onGo('/shift')}>Open a shift</button>
              </div>
            </div>
          )}
          <StockCard rows={data.lowStock} count={data.lowStockCount} onGo={onGo} />
        </div>
        <div className="lc-card" id="dashMyBills">
          <h3>Your last bills <button type="button" className="lc-link" onClick={() => onGo('/bills')}>All bills</button></h3>
          {data.myRecentBills.length === 0 ? (
            <div className="lc-empty">
              <b>No bills yet today</b>
              <button type="button" className="lc-btn lc-btn-primary" onClick={() => onGo('/pos')}>{Icon.plus} Ring the first bill</button>
            </div>
          ) : (
            <div className="lc-list">
              {data.myRecentBills.map((b) => (
                <div className="lc-row" key={b.id}>
                  <div className="grow"><div className="t lc-num">{b.billNumber}</div><div className="s">{clock(b.createdAt)}{b.status === 'VOIDED' ? ' · voided' : ''}</div></div>
                  <span className={`lc-pill ${(b.paymentMode ?? 'CASH').toLowerCase()}`}>{b.paymentMode ?? 'CASH'}</span>
                  <span className="lc-num" style={b.status === 'VOIDED' ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>{inr2(b.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
