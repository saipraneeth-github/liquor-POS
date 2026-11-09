import { z } from 'zod';
import { INVOICE_FIELDS, type InvoiceField } from './extraction/types.js';
import { PLACEHOLDER_PREFIX } from './validate.engine.js';

/** Money: decimal string, ≤ 10 integer digits (numeric(12,2)), ≤ 2 dp. */
export const MONEY = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be a decimal string with up to 10 digits and 2dp');

/** High-precision unit cost: decimal string, <= 10 integer digits, <= 6 dp. */
export const PRECISION_MONEY = z.string().trim().regex(/^\d{1,10}(\.\d{1,6})?$/, 'must be a decimal string with up to 10 digits and up to 6dp');

const DATE = z.string().trim().refine((s) => /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s)), 'invalid date (use YYYY-MM-DD)');

const SAFE_NAME = z.string().trim().min(1).max(200).refine((s) => !/[<>]/.test(s), 'must not contain < or >');

export const InvoiceNumber = z.string().trim().min(1).max(60)
  .refine((s) => !/[<>]/.test(s), 'must not contain < or >')
  .refine((s) => !s.toUpperCase().startsWith(PLACEHOLDER_PREFIX), `invoice numbers starting with ${PLACEHOLDER_PREFIX} are reserved for drafts`);

export const LineInputSchema = z.object({
  id: z.string().uuid().optional(),
  productId: z.string().uuid().nullable().optional(),
  /** true = a person confirmed the (suggested) product for this line */
  confirmMatch: z.boolean().optional(),
  rawDescription: z.string().trim().min(1).max(500),
  barcode: z.string().trim().max(32).nullable().optional(),
  casesDelivered: z.number().int().min(0).max(100_000).nullable().optional(),
  bottlesDelivered: z.number().int().min(0).max(100_000).nullable().optional(),
  packQuantity: z.number().int().min(1).max(100_000).nullable().optional(),
  volumeMl: z.number().int().positive().nullable().optional(),
  quantity: z.number().int().min(0).max(100_000),
  caseRate: MONEY.nullable().optional(),
  costPrice: PRECISION_MONEY,
  mrp: MONEY,
  taxRate: MONEY.refine((v) => Number(v) <= 100, 'taxRate must be <= 100').optional(),
  extractedAmount: MONEY.nullable().optional(),
});
export type LineInput = z.infer<typeof LineInputSchema>;

export const InvoiceInputSchema = z.object({
  supplierName: SAFE_NAME,
  invoiceNumber: InvoiceNumber.optional(),
  invoiceDate: DATE.nullable().optional(),
  totalAmount: MONEY.optional(),
  /** "Invoice Value" printed under the item table (wholesale total of the lines). */
  linesBasicTotal: MONEY.nullable().optional(),
  mrpRoundingOff: MONEY.nullable().optional(),
  specialExciseCess: MONEY.nullable().optional(),
  turnoverTax: MONEY.nullable().optional(),
  tcsAmount: MONEY.nullable().optional(),
  challanAmount: MONEY.nullable().optional(),
  challanNumber: z.string().max(200).nullable().optional(),
  previousCredit: MONEY.nullable().optional(),
  subTotal: MONEY.nullable().optional(),
  netInvoiceValue: MONEY.nullable().optional(),
  totalInvoiceAmount: MONEY.nullable().optional(),
  retailerCreditBalance: MONEY.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  items: z.array(LineInputSchema).min(1).max(500),
});
export type InvoiceInput = z.infer<typeof InvoiceInputSchema>;

const fieldEnum = z.enum(INVOICE_FIELDS as [InvoiceField, ...InvoiceField[]]);
export const ColumnMappingSchema = z.record(fieldEnum, z.union([z.number().int().min(0).max(59), z.string().trim().min(1).max(60)]));

export const UploadFieldsSchema = z.object({
  supplierName: SAFE_NAME.optional(),
  invoiceNumber: InvoiceNumber.optional(),
  invoiceDate: DATE.optional(),
  columnMapping: z.string().max(2000).optional()
    .transform((s, ctx) => {
      if (s === undefined || s.trim() === '') return undefined;
      try {
        const parsed = ColumnMappingSchema.safeParse(JSON.parse(s));
        if (parsed.success) return parsed.data;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'columnMapping: ' + parsed.error.issues.map((i) => i.message).join('; ') });
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'columnMapping must be JSON, e.g. {"description":1,"quantity":"Qty"}' });
      }
      return z.NEVER;
    }),
});
export type UploadFields = z.infer<typeof UploadFieldsSchema>;

export const ListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'REVIEWED', 'APPROVED', 'REJECTED']).optional(),
  from: DATE.optional(),
  to: DATE.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

export const RejectSchema = z.object({ reason: z.string().trim().min(5).max(500) });
