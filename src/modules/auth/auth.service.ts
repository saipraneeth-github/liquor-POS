import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { createHash, randomBytes } from 'node:crypto';
import { branches, passwordResets, syndicates, users } from '../../db/schema.js';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { appUrl } from '../../config/integrations.js';
import { sendMail } from '../notifications/mailer.js';
import { ACCESS_MESSAGE, accessState } from '../platform/access.engine.js';

export class SuspendedError extends Error {}

const SALT_ROUNDS = 12;

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// ─── TOKEN PAYLOAD ──────────────────────────────────────────────────────────

export type UserRole = 'owner' | 'manager' | 'cashier' | 'steward';

export interface JwtPayload {
  sub: string;        // user ID
  email: string;
  role: string;
  branchId: string | null;
  // owner scoping: NULL branch + NULL syndicate = platform owner; syndicate set = syndicate owner.
  // Optional only for tokens minted before this claim existed (treated as "unknown" → DB lookup).
  syndicateId?: string | null;
  impersonatedBy?: string;   // set on a Super Admin "sign in as" support token
  iat?: number;
  exp?: number;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(100),
}).refine((d) => d.currentPassword !== d.newPassword, { message: 'New password must differ from the current one', path: ['newPassword'] });

export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
  const [user] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !(await verifyPassword(currentPassword, user.hash))) return false;
  await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, userId));
  return true;
}

// ─── AUTH SERVICE ───────────────────────────────────────────────────────────

export async function loginUser(
  email: string,
  password: string,
  fastify: FastifyInstance,
): Promise<string> {
  const [row] = await db
    .select({ user: users, tenant: { isActive: syndicates.isActive, plan: syndicates.plan, trialEndsAt: syndicates.trialEndsAt, paidUntil: syndicates.paidUntil } })
    .from(users)
    .leftJoin(branches, eq(users.branchId, branches.id))
    .leftJoin(syndicates, eq(syndicates.id, sql`coalesce(${users.syndicateId}, ${branches.syndicateId})`))
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  const user = row?.user;

  if (!user || !user.isActive) {
    throw new Error('Invalid credentials');
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }
  if (row.tenant && row.tenant.isActive !== null) {
    // Only a suspension blocks sign-in. An ended trial / overdue payment lets the user in so the Admin can pay.
    const state = accessState(row.tenant);
    if (state === 'SUSPENDED') throw new SuspendedError(ACCESS_MESSAGE[state]);
  }

  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
    syndicateId: user.syndicateId ?? null,
  };

  // @ts-ignore — fastify-jwt types
  return fastify.jwt.sign(payload);
}

// ─── FORGOT PASSWORD (e-mailed link) ────────────────────────────────────────

const RESET_TTL_MS = 60 * 60 * 1000;      // link valid for one hour
const RESET_COOLDOWN_MS = 60 * 1000;      // one e-mail per minute per account

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export const ForgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const ResetPasswordSchema = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(8).max(100) });

/**
 * Always resolves quietly: whether the address exists must not be revealed. Only the e-mailed token can
 * finish the reset; it is stored hashed and works once.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await db.select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive })
    .from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !user.isActive) return;

  const [recent] = await db.select({ id: passwordResets.id }).from(passwordResets)
    .where(and(eq(passwordResets.userId, user.id), gt(passwordResets.createdAt, new Date(Date.now() - RESET_COOLDOWN_MS)))).limit(1);
  if (recent) return;

  const token = randomBytes(32).toString('hex');
  await db.insert(passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  await sendMail({
    to: user.email,
    kind: 'password_reset',
    subject: 'Reset your Liquor Counter password',
    text: `Hi ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${appUrl()}/reset-password?token=${token}\n\nIf you did not ask for this, ignore this e-mail; your password stays the same.`,
  });
}

/** Returns false for an unknown, used or expired token. */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<boolean> {
  const hash = await hashPassword(newPassword);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
      .returning({ userId: passwordResets.userId });
    if (!row) return false;
    await tx.update(users).set({ passwordHash: hash }).where(eq(users.id, row.userId));
    // Any other outstanding link for this account is now void
    await tx.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, row.userId), isNull(passwordResets.usedAt)));
    return true;
  });
}
