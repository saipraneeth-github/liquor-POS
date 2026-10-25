import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  AsOfQuerySchema,
  CreateLedgerSchema,
  DateRangeQuerySchema,
  ManualJournalSchema,
  VoucherQuerySchema,
  createLedger,
  createManualJournal,
  exportTally,
  getBalanceSheet,
  getLedgerStatement,
  getProfitLoss,
  getTrialBalance,
  listLedgers,
  listVouchers,
} from './accounting.service.js';

const BranchParamsSchema = z.object({ branchId: z.string().uuid() });
const LedgerParamsSchema = z.object({ branchId: z.string().uuid(), ledgerId: z.string().uuid() });
const TallyQuerySchema = z.object({ company: z.string().trim().max(200).optional() });

function validationError(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: 'Validation failed', details: error.flatten() });
}

// ─── ACCOUNTING ROUTES (manager+, branch-scoped) ─────────────────────────────

export async function accountingRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireRole('manager') };

  // GET /accounting/ledgers/:branchId?asOf= — chart of accounts with balances
  fastify.get('/accounting/ledgers/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const query = AsOfQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await listLedgers(params.data.branchId, query.data.asOf);
    } catch (err) {
      return sendError(reply, err, 'Failed to load ledgers');
    }
  });

  // POST /accounting/ledgers/:branchId — custom (non-system) ledger
  fastify.post('/accounting/ledgers/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const body = CreateLedgerSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return reply.code(201).send(await createLedger(params.data.branchId, body.data));
    } catch (err) {
      return sendError(reply, err, 'Failed to create ledger');
    }
  });

  // GET /accounting/ledgers/:branchId/:ledgerId/entries?from=&to= — ledger statement with running balance
  fastify.get('/accounting/ledgers/:branchId/:ledgerId/entries', guard, async (request, reply) => {
    const params = LedgerParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Ledger not found' });
    const query = DateRangeQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await getLedgerStatement(params.data.branchId, params.data.ledgerId, query.data);
    } catch (err) {
      return sendError(reply, err, 'Failed to load ledger entries');
    }
  });

  // GET /accounting/vouchers/:branchId?from=&to=&type=&limit= — day book with lines
  fastify.get('/accounting/vouchers/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const query = VoucherQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await listVouchers(params.data.branchId, query.data);
    } catch (err) {
      return sendError(reply, err, 'Failed to load vouchers');
    }
  });

  // POST /accounting/journal/:branchId — manual JOURNAL voucher (must balance → 422 otherwise)
  fastify.post('/accounting/journal/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const body = ManualJournalSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error);
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      return reply.code(201).send(await createManualJournal(params.data.branchId, body.data, user));
    } catch (err) {
      return sendError(reply, err, 'Failed to post journal');
    }
  });

  // GET /accounting/trial-balance/:branchId?asOf=
  fastify.get('/accounting/trial-balance/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const query = AsOfQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await getTrialBalance(params.data.branchId, query.data.asOf);
    } catch (err) {
      return sendError(reply, err, 'Failed to build trial balance');
    }
  });

  // GET /accounting/profit-loss/:branchId?from=&to=
  fastify.get('/accounting/profit-loss/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const query = DateRangeQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await getProfitLoss(params.data.branchId, query.data);
    } catch (err) {
      return sendError(reply, err, 'Failed to build profit & loss');
    }
  });

  // GET /accounting/balance-sheet/:branchId?asOf=
  fastify.get('/accounting/balance-sheet/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const query = AsOfQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await getBalanceSheet(params.data.branchId, query.data.asOf);
    } catch (err) {
      return sendError(reply, err, 'Failed to build balance sheet');
    }
  });

  // GET /accounting/tally-export/:branchId?from=&to=&company= — Tally Prime / ERP 9 voucher import XML
  fastify.get('/accounting/tally-export/:branchId', guard, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error);
    const range = DateRangeQuerySchema.safeParse(request.query);
    if (!range.success) return validationError(reply, range.error);
    const extra = TallyQuerySchema.safeParse(request.query);
    if (!extra.success) return validationError(reply, extra.error);
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      const { xml, filename } = await exportTally(params.data.branchId, range.data, extra.data.company);
      return reply
        .header('Content-Type', 'application/xml; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(xml);
    } catch (err) {
      return sendError(reply, err, 'Tally export failed');
    }
  });
}
