import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import {
  parseInvoice,
  approveInwardInvoice,
  getStockStatus,
  getBranchIndentEstimations,
} from './inventory.service.js';

const RawInvoiceSchema = z.object({
  supplierName: z.string().min(1),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string(),
  claimedTotal: z.string(),
  items: z.array(
    z.object({
      rawDescription: z.string(),
      barcode: z.string().optional(),
      quantity: z.number().int().positive(),
      costPrice: z.string(),
      mrp: z.string(),
      taxRate: z.string().optional(),
    }),
  ),
});

const ApproveInvoiceSchema = z.object({
  branchId: z.string().uuid(),
  supplierName: z.string().min(1),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string().optional(),
  totalAmount: z.string(),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      rawDescription: z.string(),
      quantity: z.number().int().positive(),
      costPrice: z.string(),
      mrp: z.string(),
      taxRate: z.string().optional(),
    }),
  ),
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

    if (!assertBranchAccess(user, parsed.data.branchId, reply)) return;

    try {
      const invoice = await approveInwardInvoice(parsed.data, user);
      return reply.code(201).send(invoice);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invoice approval failed';
      return reply.code(422).send({ error: msg });
    }
  });

  // GET /inventory/stock/:branchId — real-time stock levels with shortage alerts (cashier+)
  fastify.get('/inventory/stock/:branchId', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const user = getUser(request);
    if (!assertBranchAccess(user, branchId, reply)) return;

    const stockList = await getStockStatus(branchId);
    return stockList;
  });

  // GET /inventory/indent/:branchId — auto indent estimation (manager+)
  fastify.get('/inventory/indent/:branchId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const user = getUser(request);
    if (!assertBranchAccess(user, branchId, reply)) return;

    const suggestions = await getBranchIndentEstimations(branchId);
    return suggestions;
  });
}
