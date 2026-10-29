
## $(date +%Y-%m-%d) - Optimize applyApprovedInvoice N+1 queries
**Learning:** In bulk operations with `applyApprovedInvoice`, performing single DB queries in a `for...of` loop can result in N+1 queries and block the thread unnecessarily, degrading backend performance significantly. Wait, also PostgreSQL throws `ON CONFLICT DO UPDATE command cannot affect row a second time` if you attempt to batch-update the same row multiple times in one statement (e.g. duplicate products in the same invoice).
**Action:** Always batch `INSERT` with `onConflictDoUpdate` using `EXCLUDED` fields, and pre-aggregate duplicate constraints (like product quantities in an invoice) beforehand using a `Map` in JavaScript. Also, use `Promise.all` to batch updates that cannot be inserted/upserted.
