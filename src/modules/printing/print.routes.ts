/**
 * print.routes.ts — Customer bill and KOT printing.
 *
 * GET  /api/v1/print/bills/:id?format=html|text|escpos|json&interState=true   — render a bill (cashier+)
 * GET  /api/v1/print/kot/:id?format=...                                       — render a KOT ticket (steward+)
 * POST /api/v1/print/bills/:id/send                                           — send to the branch's network printer
 * POST /api/v1/print/kot/:id/send                                             — send to the branch's network printer
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError, NotFoundError } from '../../lib/errors.js';
import { db } from '../../db/client.js';
import { branches } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildTestRows, renderEscPos, renderHtml, widthChars } from '../../lib/print/index.js';
import { createAgentJob } from './agent.service.js';
import { enqueuePrintJob, getPrintJob, listPrintJobs, retryPrintJob, processDueJobs } from './print-queue.service.js';
import {
  PRINT_FORMATS,
  loadBillPrintModel,
  loadKotPrintModel,
  renderBill,
  renderKot,
  sendToBranchPrinter,
} from './print.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const RenderQuery = z.object({
  format: z.enum(PRINT_FORMATS).default('html'),
  interState: z.enum(['true', 'false']).optional(),
});
/** undefined = derive from the buyer's GSTIN; true/false = forced by the caller */
const flag = (v?: 'true' | 'false') => (v === undefined ? undefined : v === 'true');
const SendQuery = z.object({
  interState: z.enum(['true', 'false']).optional(),
  queue: z.enum(['true', 'false']).optional(),   // keep the job and retry when the printer is unreachable
});

/** Sends now; with queue=true an unreachable printer parks the job for retry instead of failing the request. */
async function sendOrQueue(
  reply: FastifyReply,
  branch: { printerHost: string | null; printerPort: number; printViaAgent?: boolean },
  branchId: string,
  kind: 'bill' | 'kot',
  refId: string,
  bytes: Buffer,
  queue: boolean,
) {
  // A branch with a local print agent never prints over TCP from the server: the agent picks the job up
  if (branch.printViaAgent) {
    const job = await createAgentJob(branchId, kind, refId, bytes);
    return reply.code(202).send({ sent: false, queued: true, agent: true, jobId: job.id });
  }
  try {
    await sendToBranchPrinter(branch, bytes);
    return { sent: true };
  } catch (err) {
    if (queue && branch.printerHost) {
      const job = await enqueuePrintJob(branchId, kind, refId, (err as Error).message);
      return reply.code(202).send({ sent: false, queued: true, jobId: job.id });
    }
    throw err;
  }
}

const BranchParams = z.object({ branchId: z.string().uuid() });

export async function printRoutes(app: FastifyInstance) {
  // Test ticket for the branch printer settings screen. ?send=true pushes it to the network printer,
  // otherwise it is returned as HTML for browser printing.
  app.post('/print/test/:branchId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const [branch] = await db.select().from(branches).where(eq(branches.id, params.data.branchId)).limit(1);
      if (!branch) throw new NotFoundError('Branch not found');
      const paper = branch.paperWidth === '80mm' ? '80mm' : '58mm';
      const rows = buildTestRows(branch.name, paper, branch.printViaAgent ? 'local print agent' : branch.printerHost);
      const bytes = renderEscPos(rows, widthChars(paper));
      if (branch.printViaAgent) {
        const job = await createAgentJob(branch.id, 'test', null, bytes);
        return reply.code(202).send({ sent: false, queued: true, agent: true, jobId: job.id });
      }
      await sendToBranchPrinter(branch, bytes);
      return { sent: true };
    } catch (err) {
      return sendError(reply, err, 'Test print failed');
    }
  });

  app.get('/print/jobs/:branchId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    if (!(await assertBranchAccess(getUser(req), params.data.branchId, reply))) return;
    return { jobs: await listPrintJobs(params.data.branchId) };
  });

  app.post('/print/jobs/:id/retry', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Print job not found' });
    try {
      const job = await getPrintJob(params.data.id);
      if (!(await assertBranchAccess(getUser(req), job.branchId, reply))) return;
      await retryPrintJob(job.id);
      await processDueJobs();
      return await getPrintJob(job.id);
    } catch (err) {
      return sendError(reply, err, 'Retry failed');
    }
  });

  app.get('/print/bills/:id', { preHandler: requireRole('cashier') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const query = RenderQuery.safeParse(req.query);
    if (!params.success) return reply.code(404).send({ error: 'Bill not found' });
    if (!query.success) return reply.code(400).send({ error: 'Invalid print options' });
    try {
      const { model, billBranchId, cashDrawer } = await loadBillPrintModel(params.data.id, flag(query.data.interState));
      if (!(await assertBranchAccess(getUser(req), billBranchId, reply))) return;
      const doc = renderBill(model, query.data.format, cashDrawer);
      return reply.type(doc.contentType).send(doc.body);
    } catch (err) {
      return sendError(reply, err, 'Could not render bill');
    }
  });

  app.get('/print/kot/:id', { preHandler: requireRole('steward') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const query = RenderQuery.safeParse(req.query);
    if (!params.success) return reply.code(404).send({ error: 'KOT not found' });
    if (!query.success) return reply.code(400).send({ error: 'Invalid print options' });
    try {
      const { model, branchId } = await loadKotPrintModel(params.data.id);
      if (!(await assertBranchAccess(getUser(req), branchId, reply))) return;
      const doc = renderKot(model, query.data.format);
      return reply.type(doc.contentType).send(doc.body);
    } catch (err) {
      return sendError(reply, err, 'Could not render KOT');
    }
  });

  app.post('/print/bills/:id/send', { preHandler: requireRole('cashier') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const query = SendQuery.safeParse(req.query);
    if (!params.success) return reply.code(404).send({ error: 'Bill not found' });
    if (!query.success) return reply.code(400).send({ error: 'Invalid print options' });
    try {
      const { model, branch, billBranchId, cashDrawer } = await loadBillPrintModel(params.data.id, flag(query.data.interState));
      if (!(await assertBranchAccess(getUser(req), billBranchId, reply))) return;
      const doc = renderBill(model, 'escpos', cashDrawer);
      return await sendOrQueue(reply, branch, billBranchId, 'bill', params.data.id, doc.body as Buffer, query.data.queue === 'true');
    } catch (err) {
      return sendError(reply, err, 'Printing failed');
    }
  });

  app.post('/print/kot/:id/send', { preHandler: requireRole('steward') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'KOT not found' });
    try {
      const { model, branch, branchId } = await loadKotPrintModel(params.data.id);
      if (!(await assertBranchAccess(getUser(req), branchId, reply))) return;
      const doc = renderKot(model, 'escpos');
      return await sendOrQueue(reply, branch, branchId, 'kot', params.data.id, doc.body as Buffer, (req.query as { queue?: string })?.queue === 'true');
    } catch (err) {
      return sendError(reply, err, 'Printing failed');
    }
  });
}
