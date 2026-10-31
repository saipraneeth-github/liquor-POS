/**
 * integrations.ts — Every external dependency in one place.
 *
 * Nothing here is required to run the app: with no values set it uses safe stand-ins
 * (test payment gateway, e-mail written to the outbox table instead of sent).
 * Put the real values in `.env` (see `.env.example` and INTEGRATIONS.md) and restart.
 * Read lazily so tests can change process.env.
 */

export type PaymentProvider = 'razorpay' | 'mock';

export interface PaymentConfig {
  /** Which gateway checks customers out. 'mock' = built-in test gateway (no money moves). */
  provider: PaymentProvider;
  currency: 'INR';
  razorpay: { keyId: string; keySecret: string; webhookSecret: string };
  /** Secret used to sign test-gateway payments; never used in production. */
  mockSecret: string;
}

export interface MailConfig {
  /** 'smtp' when SMTP_HOST is set, otherwise 'log' (messages are stored in email_outbox only). */
  transport: 'smtp' | 'log';
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
}

export function appUrl(): string {
  return (process.env.APP_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

export function paymentConfig(): PaymentConfig {
  const wanted = (process.env.PAYMENT_PROVIDER ?? '').toLowerCase();
  const razorpay = {
    keyId: process.env.RAZORPAY_KEY_ID ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  };
  // Razorpay only when explicitly chosen AND the keys are present; anything else falls back to the test gateway
  const provider: PaymentProvider = wanted === 'razorpay' && razorpay.keyId && razorpay.keySecret ? 'razorpay' : 'mock';
  return { provider, currency: 'INR', razorpay, mockSecret: process.env.MOCK_PAYMENT_SECRET || 'dev-only-mock-secret' };
}

export function mailConfig(): MailConfig {
  const host = process.env.SMTP_HOST ?? '';
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    transport: host ? 'smtp' : 'log',
    from: process.env.MAIL_FROM || 'Liquor Counter <no-reply@localhost>',
    smtp: {
      host,
      port,
      secure: (process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')) === 'true',
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
    },
  };
}

export interface IntegrationStatus {
  key: string;
  name: string;
  mode: 'live' | 'test';
  ready: boolean;
  summary: string;
  missing: string[];   // env vars still to provide
}

/** What the Super Admin sees: which integrations are live and which env vars are still missing. No secrets. */
export function integrationStatus(): IntegrationStatus[] {
  const pay = paymentConfig();
  const mail = mailConfig();
  const wantsRazorpay = (process.env.PAYMENT_PROVIDER ?? '').toLowerCase() === 'razorpay';
  const payMissing = [
    ...(wantsRazorpay ? [] : ['PAYMENT_PROVIDER=razorpay']),
    ...(process.env.RAZORPAY_KEY_ID ? [] : ['RAZORPAY_KEY_ID']),
    ...(process.env.RAZORPAY_KEY_SECRET ? [] : ['RAZORPAY_KEY_SECRET']),
    ...(process.env.RAZORPAY_WEBHOOK_SECRET ? [] : ['RAZORPAY_WEBHOOK_SECRET']),
  ];
  const mailMissing = [
    ...(process.env.SMTP_HOST ? [] : ['SMTP_HOST']),
    ...(process.env.SMTP_USER ? [] : ['SMTP_USER']),
    ...(process.env.SMTP_PASS ? [] : ['SMTP_PASS']),
    ...(process.env.MAIL_FROM ? [] : ['MAIL_FROM']),
  ];
  return [
    {
      key: 'payments',
      name: 'Payment gateway (Razorpay)',
      mode: pay.provider === 'razorpay' ? 'live' : 'test',
      ready: pay.provider === 'razorpay' && !!pay.razorpay.webhookSecret,
      summary: pay.provider === 'razorpay'
        ? pay.razorpay.webhookSecret ? 'Razorpay checkout and webhook are active.' : 'Razorpay checkout is active; add the webhook secret so payments confirm even if the browser closes.'
        : 'Using the built-in test gateway: no real money moves.',
      missing: pay.provider === 'razorpay' && pay.razorpay.webhookSecret ? [] : payMissing,
    },
    {
      key: 'mail',
      name: 'E-mail (SMTP)',
      mode: mail.transport === 'smtp' ? 'live' : 'test',
      ready: mail.transport === 'smtp' && !!process.env.MAIL_FROM,
      summary: mail.transport === 'smtp' ? `Sending through ${mail.smtp.host}.` : 'No SMTP configured: e-mails are only stored in the outbox.',
      missing: mail.transport === 'smtp' && process.env.MAIL_FROM ? [] : mailMissing,
    },
    {
      key: 'app',
      name: 'Public web address',
      mode: process.env.APP_URL ? 'live' : 'test',
      ready: !!process.env.APP_URL,
      summary: process.env.APP_URL ? `Links in e-mails point to ${appUrl()}.` : 'APP_URL not set: e-mail links use http://localhost:3001.',
      missing: process.env.APP_URL ? [] : ['APP_URL'],
    },
  ];
}
