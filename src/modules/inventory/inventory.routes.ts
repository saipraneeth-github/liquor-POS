import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';

const MONEY = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal string with up to 2dp');
import {
  parseInvoice,
  approveInwardInvoice,
  getStockStatus,
  getBranchIndentEstimations,
} from './inventory.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });

const RawInvoiceSchema = z.object({
  supplierName: z.string().min(1),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string(),
  claimedTotal: MONEY,
  items: z.array(
    z.object({
      rawDescription: z.string(),
      barcode: z.string().optional(),
      quantity: z.number().int().positive(),
      costPrice: MONEY,
      mrp: MONEY,
      taxRate: MONEY.optional(),
    }),
  ),
});

const ApproveInvoiceSchema = z.object({
  branchId: z.string().uuid(),
  supplierName: z.string().min(1),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date').optional(),
  totalAmount: MONEY,
  notes: z.string().max(1000).optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      rawDescription: z.string().min(1),
      quantity: z.number().int().positive(),
      costPrice: MONEY,
      mrp: MONEY.refine((v) => Number(v) > 0, 'MRP must be positive'),
      taxRate: MONEY.refine((v) => Number(v) <= 100, 'taxRate must be <= 100').optional(),
    }),
  ).min(1),
});

export async function inventoryRoutes(fastify: FastifyInstance) {
  // POST /inventory/invoices/parse — AI invoice parser and catalog matcher (manager+)
  fastify.post('/inventory/invoices/parse', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const parsed = RawInvoiceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const result = await parseInvoice(parsed.data);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invoice parsing failed';
      return reply.code(422).send({ error: msg });
    }
  });

  // POST /inventory/invoices/approve — approve invoice and update stock (manager+)
  fastify.post('/inventory/invoices/approve', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const user = getUser(request);
    const parsed = ApproveInvoiceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    if (!(await assertBranchAccess(user, parsed.data.branchId, reply))) return;

    try {
      const invoice = await approveInwardInvoice(parsed.data, user);
      return reply.code(201).send(invoice);
    } catch (err: unknown) {
      return sendError(reply, err, 'Invoice approval failed');
    }
  });

  // GET /inventory/stock/:branchId — real-time stock levels with shortage alerts (cashier+)
  fastify.get('/inventory/stock/:branchId', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const { branchId } = params.data;
    const user = getUser(request);
    if (!(await assertBranchAccess(user, branchId, reply))) return;

    const stockList = await getStockStatus(branchId);
    return stockList;
  });

  // GET /inventory/indent/:branchId — auto indent estimation (manager+)
  fastify.get('/inventory/indent/:branchId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const { branchId } = params.data;
    const user = getUser(request);
    if (!(await assertBranchAccess(user, branchId, reply))) return;

    const suggestions = await getBranchIndentEstimations(branchId);
    return suggestions;
  });
}
