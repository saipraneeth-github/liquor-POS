## 2025-02-27 - [SQL Injection via sql tag interpolation]
**Vulnerability:** Found multiple instances where user input was interpolated directly into Drizzle's `sql` tagged template literals (e.g., `sql\`lower(${users.email}) = ${input.email}\``). While Drizzle does parameterize these inputs automatically, it's safer and less ambiguous to use native functions.
**Learning:** Using raw SQL strings for comparisons is error-prone and can lead to logic bugs (like comparing lowercase to non-lowercase inputs) or potential SQL injection if not careful.
**Prevention:** Always use Drizzle's native helper functions (`eq()`, `ilike()`, `or()`, etc.) alongside `sql` tags to enforce strict parameterization and prevent potential SQL injection vulnerabilities.
