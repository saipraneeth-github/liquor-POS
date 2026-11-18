import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL = 'pglite://memory';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  },
}));

import { CreateProductSchema } from '../../src/modules/products/product.service.js';

describe('Master Catalog & Product Enhancements', () => {
  describe('CreateProductSchema (MRP Optionality)', () => {
    it('allows omitting MRP and validates successfully', () => {
      const parsed = CreateProductSchema.safeParse({
        categoryId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        name: 'Haywards 5000 Super Strong Beer 650ml',
        brand: 'Haywards 5000',
        volumeMl: 650,
        packQuantity: 12,
        exciseCode: '5028',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mrp).toBeUndefined();
      }
    });

    it('allows valid decimal MRP strings', () => {
      const parsed = CreateProductSchema.safeParse({
        categoryId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        name: 'Haywards 5000 Super Strong Beer 650ml',
        brand: 'Haywards 5000',
        mrp: '180.00',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mrp).toBe('180.00');
      }
    });

    it('allows zero MRP string', () => {
      const parsed = CreateProductSchema.safeParse({
        categoryId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        name: 'Haywards 5000 Super Strong Beer 650ml',
        mrp: '0.00',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects negative MRP strings', () => {
      const parsed = CreateProductSchema.safeParse({
        categoryId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        name: 'Haywards 5000 Super Strong Beer 650ml',
        mrp: '-50.00',
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('Description Case Sanitization', () => {
    function sanitizeDescription(raw: string): string {
      return raw
        .replace(/\s*\[\d+\s*cs(?:\s*\+\s*\d+\s*btls?)?\]/gi, '')
        .replace(/\s*\(\d+\s*cs(?:\s*\+\s*\d+\s*btls?)?\)/gi, '')
        .replace(/\s+\d+\s*cs\b/gi, '')
        .trim();
    }

    it('strips bracketed case qualifiers like [50 cs]', () => {
      expect(sanitizeDescription('HAYWARDS 5000 SUPER STRONG BEER [50 cs]'))
        .toBe('HAYWARDS 5000 SUPER STRONG BEER');
    });

    it('strips composite case qualifiers like [10 cs + 4 btls]', () => {
      expect(sanitizeDescription('ROYAL CHALLENGE WHISKY 750ML [10 cs + 4 btls]'))
        .toBe('ROYAL CHALLENGE WHISKY 750ML');
    });

    it('strips parenthesis case qualifiers like (50 cs)', () => {
      expect(sanitizeDescription('KINGFISHER PREMIUM LAGER (50 cs)'))
        .toBe('KINGFISHER PREMIUM LAGER');
    });

    it('preserves clean descriptions without case info', () => {
      expect(sanitizeDescription('OLD MONK XXX RUM 750ML'))
        .toBe('OLD MONK XXX RUM 750ML');
    });
  });
});
