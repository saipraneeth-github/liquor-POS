## 2026-10-25 - Missing Rate Limiting on Login Endpoint
**Vulnerability:** The `/auth/login` endpoint lacked rate limiting protection.
**Learning:** High-value authentication endpoints are prime targets for credential stuffing and brute-force attacks and must be protected by default.
**Prevention:** Apply rate limiting to all authentication-related endpoints using `@fastify/rate-limit` with `global: false` to allow granular per-route control.

## 2024-10-27 - Hardcoded JWT Secret in Configuration
**Vulnerability:** A hardcoded string ('dev_secret_change_me') was used as a fallback for the JWT_SECRET in `src/app.ts`.
**Learning:** Hardcoding secrets as fallbacks for development can lead to production vulnerabilities if environment variables are misconfigured. It exposes sensitive token signing keys in version control.
**Prevention:** Always use dynamically generated, cryptographically secure random values (e.g., `crypto.randomBytes`) for local development fallbacks, or mandate environment variables across all environments.

## 2025-05-18 - Information Leakage via Plain Errors
**Vulnerability:** The application was directly forwarding `err.message` to the client for any unhandled plain `Error` in `sendError`, leaking file paths (e.g. `ENOENT`) or system specifics.
**Learning:** Business logic errors were designed to use plain `Error`s, but this made it impossible to distinguish between a safe business message and a dangerous system exception without proper guarding.
**Prevention:** Check `err.code` and common native error types (like `TypeError` or `ReferenceError`) to mask system-level issues with a generic 500 error while logging the details.

## 2024-11-03 - SQL Injection in Drizzle ORM Queries via Direct String Interpolation
**Vulnerability:** Found multiple instances where user-controlled or variable input was directly interpolated into raw SQL template strings using Drizzle's `sql` tag for comparisons (e.g., `sql\`... = ${invoice.supplierName}\``).
**Learning:** Drizzle ORM's `sql` tag safely parameterizes values, but direct interpolation for comparison operators inside the tag circumvents type safety and could still lead to injection or unexpected behaviors if not properly combined with Drizzle's native helper functions (like `eq()`, `gte()`, `lt()`).
**Prevention:** Strictly use Drizzle's native helper functions alongside `sql` tags for any column manipulations or complex types. For example, instead of `sql\`lower(col) = ${val}\``, use `eq(sql\`lower(col)\`, val)`.
