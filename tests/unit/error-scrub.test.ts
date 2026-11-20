import { describe, it, expect } from 'vitest';
import { fingerprintOf, scrub, stripQuery } from '../../src/modules/errors/error-scrub.js';

describe('error scrubbing', () => {
  it('masks e-mail addresses and long digit runs (phones, cards), nothing else', () => {
    expect(scrub('Key (email)=(ravi.k@shop.example.in) already exists')).toBe('Key (email)=([email]) already exists');
    expect(scrub('bad phone 9876543210 and card 4111111111111111')).toBe('bad phone [number] and card [number]');
    expect(scrub('Insufficient stock: requested 5, available 3')).toBe('Insufficient stock: requested 5, available 3');
  });
  it('keeps the route but never its query string', () => {
    expect(stripQuery('/api/v1/bills?branchId=abc&search=ravi')).toBe('/api/v1/bills');
    expect(stripQuery(null)).toBeNull();
  });
});

describe('fingerprint', () => {
  const stack = (line: number) => `TypeError: x\n    at pay (D:/app/src/billing.ts:${line}:17)\n    at next (D:/app/src/x.ts:1:1)`;
  it('is the same bug when only ids, numbers and the line number differ', () => {
    const a = fingerprintOf('SERVER', 'Bill 41 not found for customer 9f1c2a3b-0000-4000-8000-123456789abc', stack(120));
    const b = fingerprintOf('SERVER', 'Bill 977 not found for customer 11111111-2222-4333-8444-555555555555', stack(131));
    expect(a).toBe(b);
  });
  it('is a different bug for a different message, source or place', () => {
    const base = fingerprintOf('SERVER', 'Cannot read properties of undefined', stack(1));
    expect(fingerprintOf('SERVER', 'Cannot read properties of null', stack(1))).not.toBe(base);
    expect(fingerprintOf('BROWSER', 'Cannot read properties of undefined', stack(1))).not.toBe(base);
    expect(fingerprintOf('SERVER', 'Cannot read properties of undefined', 'TypeError\n    at other (D:/app/src/other.ts:5:1)')).not.toBe(base);
  });
});
