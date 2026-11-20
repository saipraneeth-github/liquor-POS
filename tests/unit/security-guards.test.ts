import { describe, it, expect } from 'vitest';
import { assertZipSafe, ZipTooLargeError } from '../../src/lib/zip-guard.js';
import { ipBlockReason, hostBlockReason, resolvePrinterAddress } from '../../src/lib/print/address-policy.js';
import { isBlockedForImpersonation } from '../../src/modules/platform/impersonation.engine.js';
import { redactMailBody } from '../../src/modules/notifications/redact.js';

/** A minimal zip: one central-directory entry that CLAIMS `size` bytes uncompressed (nothing is ever inflated). */
function zipClaiming(sizes: number[]): Buffer {
  const entries = sizes.map((size) => {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt32LE(size, 24);
    return h;
  });
  const cd = Buffer.concat(entries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sizes.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16);   // central directory starts at offset 0 of this buffer
  return Buffer.concat([cd, eocd]);
}

describe('zip bomb guard', () => {
  it('accepts a normal spreadsheet', () => { expect(() => assertZipSafe(zipClaiming([4_000, 120_000, 800_000]))).not.toThrow(); });
  it('refuses one entry that claims to be huge', () => { expect(() => assertZipSafe(zipClaiming([3_000_000_000]))).toThrow(ZipTooLargeError); });
  it('refuses many parts that add up to far too much', () => {
    expect(() => assertZipSafe(zipClaiming(Array(5).fill(90 * 1024 * 1024)))).toThrow(ZipTooLargeError);
  });
  it('refuses an absurd number of parts', () => { expect(() => assertZipSafe(zipClaiming(Array(2500).fill(10)))).toThrow(ZipTooLargeError); });
  it('leaves a non-zip to the real parser', () => { expect(() => assertZipSafe(Buffer.from('not a zip at all, just text'))).not.toThrow(); });
});

describe('printer address policy', () => {
  const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
  it('always refuses the cloud metadata / link-local and unspecified addresses', () => {
    for (const env of [prod, dev]) {
      expect(ipBlockReason('169.254.169.254', env)).toMatch(/link-local/);
      expect(ipBlockReason('0.0.0.0', env)).toMatch(/unspecified/);
      expect(ipBlockReason('fe80::1', env)).toMatch(/link-local/);
      expect(ipBlockReason('::ffff:169.254.169.254', env)).toMatch(/link-local/);
    }
  });
  it('refuses loopback only in production', () => {
    expect(ipBlockReason('127.0.0.1', prod)).toMatch(/loopback/);
    expect(ipBlockReason('::1', prod)).toMatch(/loopback/);
    expect(hostBlockReason('localhost', prod)).toMatch(/loopback/);
    expect(ipBlockReason('127.0.0.1', dev)).toBeNull();
  });
  it('allows a LAN printer, unless private ranges are blocked for a hosted install', () => {
    expect(ipBlockReason('192.168.1.50', prod)).toBeNull();
    const hosted = { NODE_ENV: 'production', PRINTER_BLOCK_PRIVATE: '1' } as NodeJS.ProcessEnv;
    for (const ip of ['10.0.0.5', '172.16.4.4', '192.168.1.50', '100.64.0.1', 'fd00::1']) expect(ipBlockReason(ip, hosted)).toMatch(/private/);
    expect(ipBlockReason('172.32.0.1', hosted)).toBeNull();
    expect(ipBlockReason('8.8.8.8', hosted)).toBeNull();
  });
  it('refuses a blocked literal when connecting', async () => {
    await expect(resolvePrinterAddress('169.254.169.254')).rejects.toThrow(/not allowed/);
    expect(await resolvePrinterAddress('192.168.1.50', prod)).toBe('192.168.1.50');
  });
});

describe('support sign-in limits', () => {
  it('blocks password, user, role and platform changes but not reading or normal work', () => {
    expect(isBlockedForImpersonation('POST', '/api/v1/auth/change-password')).toBe(true);
    expect(isBlockedForImpersonation('POST', '/api/v1/users')).toBe(true);
    expect(isBlockedForImpersonation('PUT', '/api/v1/users/abc/role')).toBe(true);
    expect(isBlockedForImpersonation('POST', '/api/v1/users/abc/reset-password?x=1')).toBe(true);
    expect(isBlockedForImpersonation('GET', '/api/v1/platform/tenants')).toBe(true);
    expect(isBlockedForImpersonation('GET', '/api/v1/users')).toBe(false);
    expect(isBlockedForImpersonation('GET', '/api/v1/me')).toBe(false);
    expect(isBlockedForImpersonation('POST', '/api/v1/bills')).toBe(false);
  });
});

describe('password-reset mail kept in the outbox', () => {
  const link = 'Use this link:\nhttps://app.example/reset-password?token=' + 'a1b2c3d4'.repeat(8) + '\nBye';
  it('blanks the token of a reset mail, leaves other mail alone', () => {
    expect(redactMailBody('password_reset', link)).not.toMatch(/a1b2c3d4/);
    expect(redactMailBody('password_reset', link)).toContain('token=[removed after sending]');
    expect(redactMailBody('invoice', link)).toBe(link);
    expect(redactMailBody(undefined, link)).toBe(link);
  });
});
