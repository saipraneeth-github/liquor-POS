import bcrypt from 'bcrypt';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const SALT_ROUNDS = 12;

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// ─── TOKEN PAYLOAD ──────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;        // user ID
  email: string;
  role: string;
  branchId: string | null;
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

// ─── AUTH SERVICE ───────────────────────────────────────────────────────────

export async function loginUser(
  email: string,
  password: string,
  fastify: FastifyInstance,
): Promise<string> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user || !user.isActive) {
    throw new Error('Invalid credentials');
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
  };

  // @ts-ignore — fastify-jwt types
  return fastify.jwt.sign(payload);
}
