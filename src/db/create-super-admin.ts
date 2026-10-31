/**
 * Creates (or resets) the platform Super Admin: the owner account with no business attached.
 *
 *   npm run super-admin -- you@yourcompany.com "Your Name" "a-strong-password"
 *
 * Run it on the server against the production DATABASE_URL. Running it again for the same e-mail
 * resets that account's password and makes sure it is an active Super Admin.
 */
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { users } from './schema.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../modules/auth/auth.service.js';

const [emailArg, nameArg, passwordArg] = process.argv.slice(2);

if (!emailArg || !nameArg || !passwordArg) {
  console.error('Usage: npm run super-admin -- <email> "<name>" "<password (8+ characters)>"');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();
if (!/^\S+@\S+\.\S+$/.test(email)) {
  console.error('That does not look like an e-mail address.');
  process.exit(1);
}
if (passwordArg.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}

await runMigrations();
const passwordHash = await hashPassword(passwordArg);
const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

if (existing) {
  await db.update(users)
    .set({ name: nameArg.trim(), passwordHash, role: 'owner', branchId: null, syndicateId: null, isActive: true })
    .where(eq(users.id, existing.id));
  console.log(`Updated ${email}: now an active Super Admin with the new password.`);
} else {
  await db.insert(users).values({ name: nameArg.trim(), email, passwordHash, role: 'owner', branchId: null, syndicateId: null });
  console.log(`Created Super Admin ${email}.`);
}
process.exit(0);
