# Integrations: what to provide

The app runs today with **no external details**: payments use a built-in test gateway and e-mails are only
stored in the outbox. When you have the details, put them in `.env` (copy `.env.example`) and restart.
The Super Admin console (**Platform Console -> Integrations**) shows what is live and which values are still missing.

## 1. Payment gateway: Razorpay (INR, UPI, cards, netbanking)

| Variable | Where to get it |
|---|---|
| `PAYMENT_PROVIDER=razorpay` | switch from the test gateway |
| `RAZORPAY_KEY_ID` | Razorpay Dashboard -> Account & Settings -> API Keys (use *Test* keys first, `rzp_test_...`) |
| `RAZORPAY_KEY_SECRET` | same page, shown once when generated |
| `RAZORPAY_WEBHOOK_SECRET` | Dashboard -> Webhooks -> Add: URL `https://YOUR-DOMAIN/api/v1/webhooks/razorpay`, events `payment.captured` and `order.paid`, choose any secret and paste it here |
| `APP_URL` | public https address of this app |

How a payment flows: Admin clicks **Pay now** -> server creates a Razorpay order -> Razorpay checkout opens
in the browser -> on success the browser sends the signature to the server, which verifies it and marks the
invoice paid. The webhook confirms the same payment server-to-server, so it still counts if the browser is
closed. Both paths are idempotent (a payment is applied once).

Going live: complete Razorpay KYC, swap the Test keys for Live keys, send one real Rs 1 test.

## 2. E-mail (password reset, billing reminders)

Any SMTP provider works (your domain's mail, Google Workspace, Amazon SES, Brevo, Zoho ...).

| Variable | Example |
|---|---|
| `SMTP_HOST` | `smtp.zoho.in` |
| `SMTP_PORT` | `587` (or `465` with `SMTP_SECURE=true`) |
| `SMTP_USER` / `SMTP_PASS` | mailbox login or app password |
| `MAIL_FROM` | `"Liquor Counter <billing@yourcompany.com>"` |

Until `SMTP_HOST` is set, every e-mail is stored in the `email_outbox` table (visible to the Super Admin under
Integrations -> Outbox). That includes the password-reset link, so the flow can be tried without a mail server.

## 3. Daily billing job

Runs inside the server every 6 hours: raises the renewal invoice a week before a paid plan ends and e-mails
reminders (trial ending, renewal in 7 days / 1 day, overdue, final notice). Each reminder goes out once.
`BILLING_JOB_ENABLED=0` switches it off. Super Admin can also press **Run billing job now**.

Prices live in `src/modules/platform/platform.service.ts` (`PLAN_PRICES`).

## 4. Local print agent

No keys needed. See `print-agent/README.md`. Create the token in Business Settings.

## 5. Other values

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | 32+ random characters in production |
| `CORS_ORIGIN` | the web app's origin if it is served from a different domain |
| `DATABASE_URL` | PostgreSQL in production (PGlite is for local use) |
