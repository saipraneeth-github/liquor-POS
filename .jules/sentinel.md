## 2026-10-25 - Missing Rate Limiting on Login Endpoint
**Vulnerability:** The `/auth/login` endpoint lacked rate limiting protection.
**Learning:** High-value authentication endpoints are prime targets for credential stuffing and brute-force attacks and must be protected by default.
**Prevention:** Apply rate limiting to all authentication-related endpoints using `@fastify/rate-limit` with `global: false` to allow granular per-route control.
