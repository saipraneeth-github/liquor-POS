import { describe, it, expect } from 'vitest';
import { dunningStage, needsInvoice, daysUntil } from '../../src/modules/platform/dunning.engine.js';
import { reminderMessage } from '../../src/modules/platform/dunning.messages.js';
import { hmacHex, safeEqualHex, MockGateway } from '../../src/modules/payments/gateway.js';
import { integrationStatus, paymentConfig, mailConfig } from '../../src/config/integrations.js';
import { vi } from 'vitest';

const now = new Date('2026-11-01T10:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const paid = (paidUntil: Date | null) => ({ isActive: true, plan: 'STANDARD', trialEndsAt: null, paidUntil });
const trial = (trialEndsAt: Date | null) => ({ isActive: true, plan: 'TRIAL', trialEndsAt, paidUntil: null });

describe('dunningStage', () => {
  it('stays quiet until a week before the end', () => {
    expect(dunningStage(paid(days(20)), now)).toBeNull();
    expect(dunningStage(paid(days(8)), now)).toBeNull();
  });

  it('walks through due-in-7, due-in-1, overdue and final notice', () => {
    expect(dunningStage(paid(days(6.5)), now)?.kind).toBe('DUE_7');
    expect(dunningStage(paid(days(0.5)), now)?.kind).toBe('DUE_1');
    expect(dunningStage(paid(days(-2)), now)?.kind).toBe('OVERDUE');
    expect(dunningStage(paid(days(-6.5)), now)?.kind).toBe('GRACE_LAST');
  });

  it('uses the paid-until date as the period key so each stage is sent once per period', () => {
    expect(dunningStage(paid(days(5)), now)?.periodKey).toBe('2026-11-06');
  });

  it('trial: reminder 3 days before, then ended', () => {
    expect(dunningStage(trial(days(10)), now)).toBeNull();
    expect(dunningStage(trial(days(2)), now)?.kind).toBe('TRIAL_3');
    expect(dunningStage(trial(days(-1)), now)?.kind).toBe('TRIAL_ENDED');
  });

  it('nothing for suspended tenants or tenants without dates', () => {
    expect(dunningStage({ ...paid(days(2)), isActive: false }, now)).toBeNull();
    expect(dunningStage(paid(null), now)).toBeNull();
    expect(dunningStage(trial(null), now)).toBeNull();
  });
});

describe('needsInvoice / daysUntil', () => {
  it('a paid plan is invoiced from a week before it ends; trials never are', () => {
    expect(needsInvoice(paid(days(10)), now)).toBe(false);
    expect(needsInvoice(paid(days(7)), now)).toBe(true);
    expect(needsInvoice(paid(days(-3)), now)).toBe(true);
    expect(needsInvoice(trial(days(1)), now)).toBe(false);
    expect(needsInvoice(paid(null), now)).toBe(false);
    expect(daysUntil(days(0.2), now)).toBe(1);
  });
});

describe('reminder text', () => {
  it('names the amount and the payment page', () => {
    const m = reminderMessage('DUE_7', 'Blue Lagoon', '2999.00');
    expect(m.subject).toContain('Blue Lagoon');
    expect(m.text).toContain('2,999.00');
    expect(m.text).toContain('/settings');
    expect(reminderMessage('TRIAL_ENDED', 'X', null).text).not.toContain('Rs');
  });
});

describe('gateway primitives', () => {
  it('compares signatures in constant time and rejects different lengths', () => {
    const sig = hmacHex('k', 'order|pay');
    expect(safeEqualHex(sig, hmacHex('k', 'order|pay'))).toBe(true);
    expect(safeEqualHex(sig, hmacHex('k2', 'order|pay'))).toBe(false);
    expect(safeEqualHex(sig, 'abc')).toBe(false);
  });

  it('the test gateway signs and verifies like Razorpay', () => {
    const g = new MockGateway();
    const signature = g.sign('o1', 'p1');
    expect(g.verifyPayment({ orderId: 'o1', paymentId: 'p1', signature })).toBe(true);
    expect(g.verifyPayment({ orderId: 'o1', paymentId: 'p2', signature })).toBe(false);
  });
});

describe('integration config', () => {
  it('falls back to the test gateway and the log mailer with no environment', () => {
    vi.stubEnv('PAYMENT_PROVIDER', '');
    vi.stubEnv('SMTP_HOST', '');
    expect(paymentConfig().provider).toBe('mock');
    expect(mailConfig().transport).toBe('log');
    const status = integrationStatus();
    expect(status.every((s) => s.mode === 'test')).toBe(true);
    vi.unstubAllEnvs();
  });

  it('asking for razorpay without keys still uses the test gateway (never half-live)', () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'razorpay');
    vi.stubEnv('RAZORPAY_KEY_ID', '');
    vi.stubEnv('RAZORPAY_KEY_SECRET', '');
    expect(paymentConfig().provider).toBe('mock');
    expect(integrationStatus().find((s) => s.key === 'payments')?.missing).toContain('RAZORPAY_KEY_ID');
    vi.unstubAllEnvs();
  });

  it('SMTP on port 465 defaults to a secure connection', () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '465');
    vi.stubEnv('SMTP_SECURE', '');
    expect(mailConfig().smtp.secure).toBe(true);
    vi.unstubAllEnvs();
  });
});
