/**
 * mailer.ts — Sends e-mail through the configured SMTP server and records every message in email_outbox.
 * With no SMTP configured the message is only stored (status LOGGED), so flows work end to end in development
 * and the Super Admin can read what would have been sent.
 */

import nodemailer from 'nodemailer';
import { db } from '../../db/client.js';
import { emailOutbox } from '../../db/schema.js';
import { mailConfig } from '../../config/integrations.js';

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  kind?: string;
}

export async function sendMail(input: MailInput): Promise<'SENT' | 'LOGGED' | 'FAILED'> {
  const cfg = mailConfig();
  let status: 'SENT' | 'LOGGED' | 'FAILED' = 'LOGGED';
  let error: string | null = null;

  if (cfg.transport === 'smtp') {
    try {
      const transport = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        ...(cfg.smtp.user ? { auth: { user: cfg.smtp.user, pass: cfg.smtp.pass } } : {}),
      });
      await transport.sendMail({ from: cfg.from, to: input.to, subject: input.subject, text: input.text });
      status = 'SENT';
    } catch (err) {
      status = 'FAILED';
      error = (err as Error).message.slice(0, 300);
    }
  }

  await db.insert(emailOutbox).values({
    toEmail: input.to, subject: input.subject, body: input.text, kind: input.kind ?? null, status, error,
  }).catch(() => undefined);
  return status;
}
