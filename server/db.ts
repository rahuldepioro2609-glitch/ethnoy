import 'dotenv/config';
import { Pool } from 'pg';
import { databasePoolConfig } from './databaseCredentials.js';

// DATABASE_URL (+ optional DATABASE_PASSWORD_FILE): see server/databaseCredentials.ts.
export const pool = new Pool(databasePoolConfig(process.env));

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});
