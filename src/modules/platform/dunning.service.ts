/**
 * dunning.service.ts — Daily billing job: raises renewal invoices and e-mails reminders to each tenant's
 * Admins. Runs on a timer inside the server and on demand from the Super Admin console.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { dunningLog, subscriptionInvoices, syndicates, users } from '../../db/schema.js';
import { sendMail } from '../notifications/mailer.js';
import { dunningStage, needsInvoice } from './dunning.engine.js';
import { reminderMessage } from './dunning.messages.js';
import { generateInvoice } from './platform.service.js';

export interface BillingRunSummary {
  tenants: number;
  invoicesCreated: number;
  emailsSent: number;
}

export async function runBillingCycle(now: Date = new Date()): Promise<BillingRunSummary> {
  const summary: BillingRunSummary = { tenants: 0, invoicesCreated: 0, emailsSent: 0 };
  const tenants = await db.select().from(syndicates).where(eq(syndicates.isActive, true));

  for (const t of tenants) {
    summary.tenants++;

    if (needsInvoice(t, now)) {
      try {
        await generateInvoice(t.id, null);
        summary.invoicesCreated++;
      } catch {
        /* an unpaid invoice already exists */
      }
    }

    const stage = dunningStage(t, now);
    if (!stage) continue;

    // Claim the (stage, period) first so two overlapping runs cannot both send it
    const [claimed] = await db.insert(dunningLog)
      .values({ syndicateId: t.id, kind: stage.kind, periodKey: stage.periodKey })
      .onConflictDoNothing().returning();
    if (!claimed) continue;

    const [open] = await db.select({ amount: subscriptionInvoices.amount }).from(subscriptionInvoices)
      .where(and(eq(subscriptionInvoices.syndicateId, t.id), eq(subscriptionInvoices.status, 'PENDING'))).limit(1);
    const admins = await db.select({ email: users.email }).from(users)
      .where(and(eq(users.syndicateId, t.id), eq(users.role, 'owner'), eq(users.isActive, true)));
    const message = reminderMessage(stage.kind, t.name, open?.amount ?? null);
    for (const admin of admins) {
      await sendMail({ to: admin.email, kind: `billing_${stage.kind.toLowerCase()}`, ...message });
      summary.emailsSent++;
    }
  }
  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the daily job once per process (a minute after boot, then every 6 hours). */
export function startBillingWorker(): void {
  if (timer || process.env.BILLING_JOB_ENABLED === '0') return;
  const tick = () => { void runBillingCycle().catch(() => undefined); };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 6 * 3_600_000);
  timer.unref();
}
