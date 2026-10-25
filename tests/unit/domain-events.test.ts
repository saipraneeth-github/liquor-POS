import { describe, it, expect, beforeEach } from 'vitest';
import {
  onDomainEvent,
  emitDomainEvent,
  clearDomainEventHandlers,
  domainEventHandlerCount,
  type Tx,
} from '../../src/lib/domain-events.js';

const fakeTx = { marker: 'tx' } as unknown as Tx;
const payload = { bill: { id: 'b1' }, items: [] } as any;

describe('domain events registry', () => {
  beforeEach(() => clearDomainEventHandlers());

  it('is a no-op when no handlers are registered', async () => {
    await expect(emitDomainEvent('bill.paid', payload, fakeTx)).resolves.toBeUndefined();
  });

  it('passes payload and the transaction handle to handlers', async () => {
    const seen: unknown[] = [];
    onDomainEvent('bill.paid', (p, tx) => { seen.push(p, tx); });
    await emitDomainEvent('bill.paid', payload, fakeTx);
    expect(seen).toEqual([payload, fakeTx]);
  });

  it('runs handlers sequentially in registration order', async () => {
    const order: string[] = [];
    onDomainEvent('bill.paid', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('first');
    });
    onDomainEvent('bill.paid', () => { order.push('second'); });
    await emitDomainEvent('bill.paid', payload, fakeTx);
    expect(order).toEqual(['first', 'second']);
  });

  it('propagates handler errors (so the transaction rolls back) and stops later handlers', async () => {
    let laterRan = false;
    onDomainEvent('bill.voided', () => { throw new Error('posting failed'); });
    onDomainEvent('bill.voided', () => { laterRan = true; });
    await expect(emitDomainEvent('bill.voided', payload, fakeTx)).rejects.toThrow('posting failed');
    expect(laterRan).toBe(false);
  });

  it('only invokes handlers for the emitted event', async () => {
    let called = false;
    onDomainEvent('expense.recorded', () => { called = true; });
    await emitDomainEvent('bill.paid', payload, fakeTx);
    expect(called).toBe(false);
  });

  it('unsubscribe removes the handler', async () => {
    let count = 0;
    const off = onDomainEvent('credit.repayment', () => { count++; });
    expect(domainEventHandlerCount('credit.repayment')).toBe(1);
    off();
    await emitDomainEvent('credit.repayment', {} as any, fakeTx);
    expect(count).toBe(0);
    expect(domainEventHandlerCount('credit.repayment')).toBe(0);
  });
});
