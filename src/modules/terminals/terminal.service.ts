import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { terminals, shiftSessions } from '../../db/schema.js';
import { ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';

// ─── SCHEMAS ─────────────────────────────────────────────────────────────────

const TERMINAL_NAME = z.string().trim().min(1).max(100).refine((s) => !/[<>]/.test(s), 'Terminal name must not contain < or >');

export const CreateTerminalSchema = z.object({
  terminalName: TERMINAL_NAME,
  deviceKey:    z.string().trim().min(8).max(128).refine((s) => !/[<>]/.test(s), 'Invalid deviceKey').optional(),
});

export const UpdateTerminalSchema = z.object({
  terminalName: TERMINAL_NAME.optional(),
  isActive:     z.boolean().optional(),
}).refine((d) => d.terminalName !== undefined || d.isActive !== undefined, {
  message: 'Nothing to update',
});

export type CreateTerminalInput = z.infer<typeof CreateTerminalSchema>;
export type UpdateTerminalInput = z.infer<typeof UpdateTerminalSchema>;
export type TerminalRow = typeof terminals.$inferSelect;

// ─── QUERIES ─────────────────────────────────────────────────────────────────

export async function listTerminals(branchId: string): Promise<TerminalRow[]> {
  return db.select().from(terminals).where(eq(terminals.branchId, branchId)).orderBy(asc(terminals.terminalName));
}

export async function getTerminal(id: string): Promise<TerminalRow | undefined> {
  const [row] = await db.select().from(terminals).where(eq(terminals.id, id)).limit(1);
  return row;
}

// ─── MUTATIONS ───────────────────────────────────────────────────────────────

export function generateDeviceKey(): string {
  return randomBytes(16).toString('hex');
}

export async function createTerminal(branchId: string, input: CreateTerminalInput): Promise<TerminalRow> {
  try {
    const [row] = await db.insert(terminals).values({
      branchId,
      terminalName: input.terminalName,
      deviceKey:    input.deviceKey ?? generateDeviceKey(),
    }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Terminal name or device key already exists');
    throw err;
  }
}

export async function updateTerminal(id: string, input: UpdateTerminalInput): Promise<TerminalRow> {
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx.select().from(terminals).where(eq(terminals.id, id)).for('update');
      if (!current) throw new NotFoundError('Terminal not found');

      if (input.isActive === false && current.isActive) {
        const [open] = await tx.select({ id: shiftSessions.id }).from(shiftSessions)
          .where(and(eq(shiftSessions.terminalId, id), eq(shiftSessions.status, 'OPEN')))
          .limit(1);
        if (open) throw new ConflictError('Terminal has an open shift; close it before deactivating');
      }

      const [row] = await tx.update(terminals).set({
        ...(input.terminalName !== undefined ? { terminalName: input.terminalName } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      }).where(eq(terminals.id, id)).returning();
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Terminal name already exists in this branch');
    throw err;
  }
}
