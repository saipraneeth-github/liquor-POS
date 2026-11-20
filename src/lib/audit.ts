import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { requestContext } from './request-context.js';

/** Append-only platform audit trail. Never throws: a logging failure must not break the action. */
export async function logAudit(
  actorId: string | null,
  action: string,
  target?: { type: string; id: string },
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorId,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      // an action made with a Super Admin support token is attributed to the Super Admin, not only to the Admin it signed in as
      meta: requestContext.getStore()?.impersonatedBy ? { ...(meta ?? {}), impersonatedBy: requestContext.getStore()!.impersonatedBy } : (meta ?? null),
    });
  } catch {
    /* audit is best-effort */
  }
}
