/**
 * print-queue.service.ts — Jobs that could not reach the network printer are kept and retried with backoff,
 * so a printer that is switched off or out of paper does not lose the KOT or bill.
 */

import { and, desc, eq, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, printJobs } from '../../db/schema.js';
import { MAX_PRINT_ATTEMPTS, nextAttemptDelayMs, sendToPrinter } from '../../lib/print/index.js';
import { NotFoundError } from '../../lib/errors.js';
import { loadBillPrintModel, loadKotPrintModel, renderBill, renderKot } from './print.service.js';

export type PrintJobKind = 'bill' | 'kot';

export async function enqueuePrintJob(branchId: string, kind: PrintJobKind, refId: string, lastError: string) {
  const [job] = await db.insert(printJobs).values({
    branchId, kind, refId, attempts: 1, lastError,
    nextAttemptAt: new Date(Date.now() + (nextAttemptDelayMs(1) ?? 30_000)),
  }).returning();
  return job;
}

/** Renders the document fresh (so a corrected branch printer address applies) and sends it. */
async function deliver(job: typeof printJobs.$inferSelect): Promise<void> {
  const [branch] = await db.select().from(branches).where(eq(branches.id, job.branchId)).limit(1);
  if (!branch?.printerHost) throw new Error('No network printer is configured for this branch');
  const bytes = job.kind === 'bill'
    ? await loadBillPrintModel(job.refId).then(({ model, cashDrawer }) => renderBill(model, 'escpos', cashDrawer).body as Buffer)
    : await loadKotPrintModel(job.refId).then(({ model }) => renderKot(model, 'escpos').body as Buffer);
  await sendToPrinter(branch.printerHost, branch.printerPort, bytes);
}

/** Tries every pending job that is due. Returns how many were sent. */
export async function processDueJobs(now = new Date()): Promise<number> {
  const due = await db.select().from(printJobs)
    .where(and(eq(printJobs.status, 'PENDING'), eq(printJobs.target, 'NETWORK'), lte(printJobs.nextAttemptAt, now)))
    .orderBy(printJobs.createdAt).limit(20);
  let sent = 0;
  for (const job of due) {
    try {
      await deliver(job);
      await db.update(printJobs).set({ status: 'SENT', sentAt: new Date(), lastError: null, attempts: job.attempts + 1 }).where(eq(printJobs.id, job.id));
      sent++;
    } catch (err) {
      const attempts = job.attempts + 1;
      const delay = nextAttemptDelayMs(attempts);
      await db.update(printJobs).set({
        attempts,
        lastError: (err as Error).message.slice(0, 300),
        status: delay === null || attempts >= MAX_PRINT_ATTEMPTS ? 'FAILED' : 'PENDING',
        nextAttemptAt: new Date(now.getTime() + (delay ?? 0)),
      }).where(eq(printJobs.id, job.id));
    }
  }
  return sent;
}

export async function listPrintJobs(branchId: string, limit = 30) {
  return db.select().from(printJobs).where(eq(printJobs.branchId, branchId)).orderBy(desc(printJobs.createdAt)).limit(limit);
}

export async function getPrintJob(id: string) {
  const [job] = await db.select().from(printJobs).where(eq(printJobs.id, id)).limit(1);
  if (!job) throw new NotFoundError('Print job not found');
  return job;
}

/** Puts a failed/pending job back at the front of the queue. */
export async function retryPrintJob(id: string) {
  const job = await getPrintJob(id);
  const [row] = await db.update(printJobs)
    .set({ status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, claimedAt: null })
    .where(eq(printJobs.id, job.id)).returning();
  return row;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Called once at server start (not in tests). */
export function startPrintWorker(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => { void processDueJobs().catch(() => undefined); }, intervalMs);
  timer.unref();
}
