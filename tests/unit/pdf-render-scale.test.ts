import { describe, it, expect } from 'vitest';
import { renderScaleFor } from '../../src/modules/invoices/extraction/pdf-text.js';

describe('renderScaleFor', () => {
  it('keeps the normal scale for an A4 page', () => { expect(renderScaleFor(595, 842)).toBe(2); });
  it('shrinks a page that declares an absurd size so the canvas stays bounded', () => {
    const scale = renderScaleFor(20_000, 20_000);
    expect(scale).toBeLessThan(0.1 + 1e-9 + 0.5);
    expect(20_000 * 20_000 * scale * scale).toBeLessThanOrEqual(24_000_000 * 1.001);
  });
  it('never returns a non-positive or NaN scale', () => {
    expect(renderScaleFor(0, 0)).toBe(2);
    expect(renderScaleFor(Number.NaN, 100)).toBe(2);
    expect(renderScaleFor(1e9, 1e9)).toBeGreaterThan(0);
  });
});
