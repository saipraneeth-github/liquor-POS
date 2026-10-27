import { sql } from 'drizzle-orm';
const mySql = sql`${sql.raw('EXCLUDED.quantity')}`;
console.log(mySql);
