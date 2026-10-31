/**
 * agent.service.ts — Backend of the local print agent (print-agent/). The agent runs on a PC in the shop,
 * next to a USB / serial / Bluetooth / Windows printer, and pulls jobs from here with a per-branch secret token.
 * That lets any printer print, without the server ever reaching into the shop network.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, printJobs } from '../../db/schema.js';
import { NotFoundError } from '../../lib/errors.js';

export const AGENT_MAX_ATTEMPTS = 5;
const CLAIM_TIMEOUT_MS = 60_000;     // a job handed out but never acknowledged is offered again after this

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** New secret for a branch's agent. Shown once; only its hash is stored. Replaces any previous token. */
export async function generateAgentToken(branchId: string): Promise<string> {
  const token = `pa_${randomBytes(24).toString('hex')}`;
  const [row] = await db.update(branches).set({ agentTokenHash: sha256(token), agentLastSeenAt: null })
    .where(eq(branches.id, branchId)).returning({ id: branches.id });
  if (!row) throw new NotFoundError('Branch not found');
  return token;
}

export async function revokeAgentToken(branchId: string): Promise<void> {
  await db.update(branches).set({ agentTokenHash: null, agentLastSeenAt: null, printViaAgent: false }).where(eq(branches.id, branchId));
}

/** The branch an agent token belongs to (also records "last seen"), or null. */
export async function authenticateAgent(token: string | undefined) {
  if (!token || !token.startsWith('pa_')) return null;
  const [branch] = await db.select().from(branches).where(eq(branches.agentTokenHash, sha256(token))).limit(1);
  if (!branch) return null;
  await db.update(branches).set({ agentLastSeenAt: new Date() }).where(eq(branches.id, branch.id));
  return branch;
}

export async function createAgentJob(branchId: string, kind: 'bill' | 'kot' | 'test', refId: string | null, bytes: Uint8Array) {
  const [job] = await db.insert(printJobs).values({
    branchId,
    kind,
    refId: refId ?? branchId,
    target: 'AGENT',
    payload: Buffer.from(bytes).toString('base64'),
    attempts: 0,
    nextAttemptAt: new Date(),
  }).returning();
  return job;
}

/** Hands the agent its pending jobs. Each is claimed so two polls never print the same job twice. */
export async function claimAgentJobs(branchId: string, limit = 5, now = new Date()) {
  const cutoff = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
  const candidates = await db.select({ id: printJobs.id }).from(printJobs)
    .where(and(
      eq(printJobs.branchId, branchId), eq(printJobs.target, 'AGENT'), eq(printJobs.status, 'PENDING'),
      or(isNull(printJobs.claimedAt), lt(printJobs.claimedAt, cutoff)),
    ))
    .orderBy(printJobs.createdAt).limit(limit);

  const claimed = [];
  for (const c of candidates) {
    const [job] = await db.update(printJobs)
      .set({ claimedAt: now, attempts: sql`${printJobs.attempts} + 1` })
      .where(and(eq(printJobs.id, c.id), eq(printJobs.status, 'PENDING'), or(isNull(printJobs.claimedAt), lt(printJobs.claimedAt, cutoff))))
      .returning();
    if (job) claimed.push({ id: job.id, kind: job.kind, data: job.payload ?? '' });
  }
  return claimed;
}

export async function ackAgentJob(branchId: string, jobId: string, ok: boolean, error?: string) {
  const [job] = await db.select().from(printJobs)
    .where(and(eq(printJobs.id, jobId), eq(printJobs.branchId, branchId), eq(printJobs.target, 'AGENT'))).limit(1);
  if (!job) throw new NotFoundError('Print job not found');
  if (ok) {
    await db.update(printJobs).set({ status: 'SENT', sentAt: new Date(), lastError: null }).where(eq(printJobs.id, jobId));
    return;
  }
  await db.update(printJobs).set({
    status: job.attempts >= AGENT_MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
    claimedAt: null,
    lastError: (error ?? 'Printer error').slice(0, 300),
  }).where(eq(printJobs.id, jobId));
}

/** Whether the agent has checked in recently (it polls every few seconds). */
export function agentOnline(lastSeen: Date | null | undefined, now = new Date()): boolean {
  return !!lastSeen && now.getTime() - lastSeen.getTime() < 30_000;
}
