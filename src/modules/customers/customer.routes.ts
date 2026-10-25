/**
 * customer.routes.ts — REST API for customer khata (credit).
 *
 * GET   /api/v1/customers/:branchId?search=   — list / search customers (cashier+)
 * POST  /api/v1/customers/:branchId           — create customer (cashier+; credit fields manager+)
 * GET   /api/v1/customers/:branchId/outstanding — customers owing money + total (manager+)
 * PATCH /api/v1/customers/:id                 — update customer (credit fields / isActive manager+)
 * GET   /api/v1/customers/:id/statement       — khata statement, newest first (cashier+)
 * POST  /api/v1/customers/:id/repayments      — record a repayment (cashier+)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { requireRole, getUser, assertBranchAccess, roleRank, ROLE_RANK } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  CreateCustomerSchema,
  UpdateCustomerSchema,
  RepaymentSchema,
  ListCustomersQuerySchema,
  listCustomers,
  createCustomer,
  updateCustomer,
  getCustomerById,
  getCustomerStatement,
  recordRepayment,
  getOutstanding,
} from './customer.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });
const CustomerParams = z.object({ id: z.string().uuid() });

function isManagerPlus(role: string): boolean {
  return roleRank(role) >= ROLE_RANK.manager;
}

export async function customerRoutes(app: FastifyInstance) {
  // ─── LIST / SEARCH ──────────────────────────────────────────────────────────
  app.get('/customers/:branchId', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const query = ListCustomersQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.status(400).send({ error: 'Validation failed', details: query.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    const list = await listCustomers(params.data.branchId, query.data.search, query.data.limit);
    return reply.send({ customers: list });
  });

  // ─── CREATE ─────────────────────────────────────────────────────────────────
  app.post('/customers/:branchId', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const body = CreateCustomerSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;

    const grantsCredit = body.data.creditAllowed === true
      || (body.data.creditLimit !== undefined && new Decimal(body.data.creditLimit).greaterThan(0));
    if (grantsCredit && !isManagerPlus(user.role)) {
      return reply.status(403).send({ error: 'Forbidden: only manager or higher may grant credit' });
    }

    try {
      const customer = await createCustomer(params.data.branchId, body.data);
      return reply.status(201).send({ customer });
    } catch (err) {
      return sendError(reply, err, 'Customer creation failed');
    }
  });

  // ─── OUTSTANDING ────────────────────────────────────────────────────────────
  app.get('/customers/:branchId/outstanding', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    return reply.send(await getOutstanding(params.data.branchId));
  });

  // ─── UPDATE ─────────────────────────────────────────────────────────────────
  app.patch('/customers/:id', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = CustomerParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Customer not found' });
    const body = UpdateCustomerSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });

    const customer = await getCustomerById(params.data.id);
    if (!customer) return reply.status(404).send({ error: 'Customer not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, customer.branchId, reply))) return;

    const touchesPrivileged = body.data.creditAllowed !== undefined
      || body.data.creditLimit !== undefined
      || body.data.isActive !== undefined;
    if (touchesPrivileged && !isManagerPlus(user.role)) {
      return reply.status(403).send({ error: 'Forbidden: only manager or higher may change credit settings' });
    }

    try {
      const updated = await updateCustomer(params.data.id, body.data);
      return reply.send({ customer: updated });
    } catch (err) {
      return sendError(reply, err, 'Customer update failed');
    }
  });

  // ─── STATEMENT ──────────────────────────────────────────────────────────────
  app.get('/customers/:id/statement', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = CustomerParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Customer not found' });
    const customer = await getCustomerById(params.data.id);
    if (!customer) return reply.status(404).send({ error: 'Customer not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, customer.branchId, reply))) return;
    return reply.send(await getCustomerStatement(customer));
  });

  // ─── REPAYMENT ──────────────────────────────────────────────────────────────
  app.post('/customers/:id/repayments', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = CustomerParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Customer not found' });
    const body = RepaymentSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });

    const customer = await getCustomerById(params.data.id);
    if (!customer) return reply.status(404).send({ error: 'Customer not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, customer.branchId, reply))) return;

    try {
      const result = await recordRepayment(params.data.id, body.data, user);
      return reply.status(result.replayed ? 200 : 201).send(result);
    } catch (err) {
      return sendError(reply, err, 'Repayment failed');
    }
  });
}
