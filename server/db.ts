import 'dotenv/config';
import pg, { Pool } from 'pg';

// Return SQL DATE values (date of birth, exam and registration dates) as plain 'YYYY-MM-DD' text.
// The default turns them into JavaScript timestamps at local midnight, which show up as
// '2007-05-14T00:00:00.000Z' on screen and can move to the previous day in other time zones.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL must be set before starting the API.');
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : undefined,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});
