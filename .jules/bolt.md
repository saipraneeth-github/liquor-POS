## 2024-05-14 - N+1 Query in Drizzle ORM
**Learning:** Found an N+1 query problem where `Promise.all(ids.map(id => getById(id)))` was used for bulk fetches instead of Drizzle's `inArray` operator.
**Action:** Use `inArray` to fetch multiple items in a single query to reduce database roundtrips.
