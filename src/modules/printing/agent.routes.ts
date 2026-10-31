/**
 * agent.routes.ts — Endpoints for the local print agent and for managing its token.
 *
 * Agent (Authorization: Bearer pa_<token>, no user login):
 *   GET  /api/v1/agent/jobs?limit=5        — claim pending print jobs (base64 ESC/POS bytes)
 *   POST /api/v1/agent/jobs/:id/ack        — report printed / failed
 * Staff (manager+):
 *   POST   /api/v1/branches/:id/agent-token — create/rotate the token (shown once)
 *   DELETE /api/v1/branches/:id/agent-token — revoke it and stop routing prints to the agent
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { ackAgentJob, authenticateAgent, claimAgentJobs, generateAgentToken, revokeAgentToken } from './agent.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const AckSchema = z.object({ ok: z.boolean(), error: z.string().max(500).optional() });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) });

async function agentAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization ?? '';
  const branch = await authenticateAgent(header.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!branch) {
    reply.code(401).send({ error: 'Invalid agent token' });
    return null;
  }
  return branch;
}

export async function agentRoutes(app: FastifyInstance) {
  app.get('/agent/jobs', async (req, reply) => {
    const branch = await agentAuth(req, reply);
    if (!branch) return;
    const query = LimitQuery.safeParse(req.query);
    return { branch: { id: branch.id, name: branch.name, paperWidth: branch.paperWidth }, jobs: await claimAgentJobs(branch.id, query.success ? query.data.limit : 5) };
  });

  app.post('/agent/jobs/:id/ack', async (req, reply) => {
    const branch = await agentAuth(req, reply);
    if (!branch) return;
    const params = IdParams.safeParse(req.params);
    const body = AckSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Validation failed' });
    try {
      await ackAgentJob(branch.id, params.data.id, body.data.ok, body.data.error);
      return { success: true };
    } catch (err) {
      return sendError(reply, err, 'Could not record the result');
    }
  });

  app.post('/branches/:id/agent-token', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    if (!(await assertBranchAccess(getUser(req), params.data.id, reply))) return;
    try {
      return reply.code(201).send({ token: await generateAgentToken(params.data.id) });
    } catch (err) {
      return sendError(reply, err, 'Could not create the token');
    }
  });

  app.delete('/branches/:id/agent-token', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    if (!(await assertBranchAccess(getUser(req), params.data.id, reply))) return;
    await revokeAgentToken(params.data.id);
    return { success: true };
  });
}
