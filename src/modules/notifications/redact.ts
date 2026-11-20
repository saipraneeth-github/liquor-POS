/**
 * A password-reset message carries a live token. Once it has really been delivered, the copy kept in the outbox must not be
 * a way to reset the account, so the token is blanked there. (With no SMTP configured the outbox is the only place the link
 * exists, so development keeps it; the Super Admin outbox view hides it in production.)
 */
export function redactMailBody(kind: string | undefined, text: string): string {
  return kind === 'password_reset' ? text.replace(/token=[A-Za-z0-9_-]{16,}/g, 'token=[removed after sending]') : text;
}
