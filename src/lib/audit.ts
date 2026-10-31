import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

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
      meta: meta ?? null,
    });
  } catch {
    /* audit is best-effort */
  }
}
