import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { createHash, randomBytes } from 'node:crypto';
import { branches, loginThrottle, passwordResets, syndicates, users } from '../../db/schema.js';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { appUrl } from '../../config/integrations.js';
import { sendMail } from '../notifications/mailer.js';
import { ACCESS_MESSAGE, accessState } from '../platform/access.engine.js';

export class SuspendedError extends Error {}
/** `retryAfterSeconds` lets the sign-in screen show a countdown instead of a vague "try later". */
export class TooManyAttemptsError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number = 0) { super(message); }
}
/** Wrong e-mail or password. `attemptsLeft` is how many more tries this client has before it is locked out. */
export class InvalidCredentialsError extends Error {
  constructor(public readonly attemptsLeft: number) { super('Invalid credentials'); }
}

// ─── LOGIN THROTTLE ─────────────────────────────────────────────────────────
// Two buckets, so a lockout cannot be turned into a way to lock a real user out:
//   • e-mail + client IP — 10 failures lock only THAT client from that account. Someone typing a stranger's
//     address wrong repeatedly only locks themselves out; the real user (different IP) is unaffected.
//   • e-mail alone      — 100 failures from anywhere in the window. Only a distributed attack reaches this,
//     and it is the backstop against brute-forcing one account from many addresses.
// A successful sign-in clears both. Counters live in the `login_throttle` table, so every API instance shares
// them and a restart does not reset them. Behind a reverse proxy set TRUST_PROXY so request.ip is the client.
const MAX_FAILED_PER_CLIENT = 10;
const MAX_FAILED_PER_ACCOUNT = 100;
// The e-mail-alone backstop is itself a way to lock a real user out: an attacker who spreads 100 wrong guesses over many
// addresses locks the account for everyone. So a client (e-mail + IP) that has signed in successfully in the last 30 days is
// remembered ('known:' rows, kept outside the 15-minute housekeeping) and is NOT blocked by the account-wide counter, only by
// its own. A brute-forcer still faces the account-wide limit from every new address, and the real user keeps working from theirs.
const KNOWN_CLIENT_TTL_INTERVAL = sql`interval '30 days'`;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_LOCK_INTERVAL = sql`interval '15 minutes'`;   // keep equal to LOGIN_LOCK_MS

type ThrottleState = { count: number; secondsLeft: number };

/** Live (not expired) failure counters for these keys, read in one query. */
async function readThrottle(keys: string[]): Promise<Map<string, ThrottleState>> {
  const rows = await db.select({ key: loginThrottle.key, count: loginThrottle.count, firstAt: loginThrottle.firstAt })
    .from(loginThrottle).where(inArray(loginThrottle.key, keys));
  const now = Date.now();
  const out = new Map<string, ThrottleState>();
  for (const r of rows) {
    const age = now - r.firstAt.getTime();
    if (age <= LOGIN_LOCK_MS) out.set(r.key, { count: r.count, secondsLeft: Math.max(1, Math.ceil((LOGIN_LOCK_MS - age) / 1000)) });
  }
  return out;
}

/** Counts one failure for a key; the window restarts when the previous one has expired. Atomic per key. */
async function recordFailedLogin(key: string): Promise<number> {
  const [row] = await db.insert(loginThrottle).values({ key, count: 1 })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        count: sql`case when ${loginThrottle.firstAt} < now() - ${LOGIN_LOCK_INTERVAL} then 1 else ${loginThrottle.count} + 1 end`,
        firstAt: sql`case when ${loginThrottle.firstAt} < now() - ${LOGIN_LOCK_INTERVAL} then now() else ${loginThrottle.firstAt} end`,
      },
    })
    .returning({ count: loginThrottle.count });
  if (Math.random() < 0.02) {   // housekeeping: drop expired counters now and then
    await db.delete(loginThrottle).where(sql`(${loginThrottle.key} not like 'known:%' and ${loginThrottle.firstAt} < now() - ${LOGIN_LOCK_INTERVAL}) or (${loginThrottle.key} like 'known:%' and ${loginThrottle.firstAt} < now() - ${KNOWN_CLIENT_TTL_INTERVAL})`).catch(() => undefined);
  }
  return row.count;
}

export async function resetLoginThrottle(): Promise<void> { await db.delete(loginThrottle); }

/** Has this client (e-mail + IP) signed in successfully within the last 30 days? */
async function isKnownClient(key: string): Promise<boolean> {
  const [row] = await db.select({ key: loginThrottle.key }).from(loginThrottle)
    .where(and(eq(loginThrottle.key, key), sql`${loginThrottle.firstAt} > now() - ${KNOWN_CLIENT_TTL_INTERVAL}`)).limit(1);
  return !!row;
}

/** Remembers a successful sign-in from this client (refreshes the 30 days). */
async function rememberClient(key: string): Promise<void> {
  await db.insert(loginThrottle).values({ key, count: 1 })
    .onConflictDoUpdate({ target: loginThrottle.key, set: { firstAt: sql`now()` } }).catch(() => undefined);
}

const SALT_ROUNDS = 12;

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().email(),
  // No minimum here: legacy/imported accounts may have shorter passwords. Strength is enforced when set.
  password: z.string().min(1).max(100),
});

// ─── TOKEN PAYLOAD ──────────────────────────────────────────────────────────

export type UserRole = 'owner' | 'manager' | 'office_admin' | 'cashier' | 'steward';

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

let dummyHash: Promise<string> | null = null;
/** A valid hash nobody knows the password of, made once, at the real cost factor. */
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
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
  await db.update(users).set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), mustChangePassword: false }).where(eq(users.id, userId));
  return true;
}

// ─── AUTH SERVICE ───────────────────────────────────────────────────────────

export async function loginUser(
  email: string,
  password: string,
  fastify: FastifyInstance,
  clientIp = 'unknown',
): Promise<string> {
  const accountKey = `acct:${email.toLowerCase()}`;
  const clientKey = `client:${email.toLowerCase()}|${clientIp}`;
  const throttle = await readThrottle([clientKey, accountKey]);
  const clientState = throttle.get(clientKey);
  const accountState = throttle.get(accountKey);
  const clientLocked = (clientState?.count ?? 0) >= MAX_FAILED_PER_CLIENT;
  const knownKey = `known:${email.toLowerCase()}|${clientIp}`;
  const accountLocked = (accountState?.count ?? 0) >= MAX_FAILED_PER_ACCOUNT;
  // the account-wide lock does not apply to a device the real user has signed in from before (see above)
  const lockedOut = clientLocked || (accountLocked && !(await isKnownClient(knownKey)));
  if (lockedOut) {
    throw new TooManyAttemptsError(
      'Too many failed sign-in attempts. Try again in a few minutes or reset your password.',
      (clientLocked ? clientState : accountState)?.secondsLeft ?? 1,
    );
  }
  const recordFailure = async (): Promise<never> => {
    const [clientCount] = await Promise.all([recordFailedLogin(clientKey), recordFailedLogin(accountKey)]);
    throw new InvalidCredentialsError(Math.max(0, MAX_FAILED_PER_CLIENT - clientCount));
  };
  const [row] = await db
    .select({ user: users, tenant: { isActive: syndicates.isActive, plan: syndicates.plan, trialEndsAt: syndicates.trialEndsAt, paidUntil: syndicates.paidUntil } })
    .from(users)
    .leftJoin(branches, eq(users.branchId, branches.id))
    .leftJoin(syndicates, eq(syndicates.id, sql`coalesce(${users.syndicateId}, ${branches.syndicateId})`))
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  const user = row?.user;

  if (!user || !user.isActive) {
    // Spend the same bcrypt time as a real check, so response time does not reveal which e-mails have an account
    await verifyPassword(password, await dummyPasswordHash());
    return recordFailure();
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return recordFailure();
  await db.delete(loginThrottle).where(inArray(loginThrottle.key, [clientKey, accountKey])).catch(() => undefined);
  await rememberClient(knownKey);
  if (row.tenant && row.tenant.isActive !== null) {
    // Only a suspension blocks sign-in. An ended trial / overdue payment lets the user in so the Admin can pay.
    const state = accessState(row.tenant);
    if (state === 'SUSPENDED') throw new SuspendedError(ACCESS_MESSAGE[state]);
  }

  // Best effort: a failure here must never stop someone signing in
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)).catch(() => undefined);

  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
    syndicateId: user.syndicateId ?? null,
  };

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
    await tx.update(users).set({ passwordHash: hash, passwordChangedAt: new Date(), mustChangePassword: false }).where(eq(users.id, row.userId));
    // Any other outstanding link for this account is now void
    await tx.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, row.userId), isNull(passwordResets.usedAt)));
    return true;
  });
}
