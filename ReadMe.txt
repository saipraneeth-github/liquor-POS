npm run dev - backend
npm run dev:frontend - frontend
>npm run db:migrate - db scripts
node docs/db-optimization/scripts/neon.mjs preflight - indexes

1. Create the empty database. In Neon, create a new project or branch/database, then copy its connection string. For a local Postgres, run createdb liquor_counter.

2. Point the app at it in .env:
DATABASE_URL=postgresql://USER:PASS@HOST/DBNAME?sslmode=require
JWT_SECRET=<32+ random characters>

3. Run all migrations (schema, indexes and constraints together):
npm run db:migrate
It should finish with Migrations applied. The schema "drizzle" already exists notices only mean the tracking table was found.

4. Check it worked (Neon SQL Editor or psql):
select count(*) from drizzle.__drizzle_migrations;   -- 26
select count(*) from pg_constraint
  where connamespace='public'::regnamespace and conname like 'ck\_%';   -- 11
select count(*) from pg_constraint
  where connamespace='public'::regnamespace and not convalidated;       -- 0

5. Create the first admin and start the app:
npm run super-admin     # creates the Super Admin; save the credentials
npm run build
npm start