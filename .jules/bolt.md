## 2026-10-26 - [Database Index for listBills and Daily Closing]
**Learning:** The `listBills` query filters on `branchId` and `createdAt`. Missing this composite index means full table scans on the heavily populated `bills` table, which will degrade performance over time.
**Action:** Add a composite index on `(branchId, createdAt)` in `src/db/schema.ts` for the `bills` table to optimize frequent paginated scans.
