import { describe, it, expect, afterEach } from 'vitest';
import { assertPaymentsSafeForProduction } from '../../src/config/integrations.js';

const KEYS = ['NODE_ENV', 'PAYMENT_PROVIDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'ALLOW_MOCK_PAYMENTS'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('assertPaymentsSafeForProduction', () => {
  it('refuses the test gateway in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.ALLOW_MOCK_PAYMENTS;
    expect(() => assertPaymentsSafeForProduction()).toThrow(/test gateway/);
  });

  it('refuses Razorpay without keys (it silently falls back to the test gateway)', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'razorpay';
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.ALLOW_MOCK_PAYMENTS;
    expect(() => assertPaymentsSafeForProduction()).toThrow();
  });

  it('allows Razorpay with keys', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'razorpay';
    process.env.RAZORPAY_KEY_ID = 'rzp_live_x';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    expect(() => assertPaymentsSafeForProduction()).not.toThrow();
  });

  it('allows the test gateway only with the explicit opt-in', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PAYMENT_PROVIDER;
    process.env.ALLOW_MOCK_PAYMENTS = '1';
    expect(() => assertPaymentsSafeForProduction()).not.toThrow();
  });

  it('does nothing outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.PAYMENT_PROVIDER;
    expect(() => assertPaymentsSafeForProduction()).not.toThrow();
  });
});
