import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

function getSslConfig() {
  return process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false;
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and set it.');
}

const pool = new Pool({
  connectionString,
  ssl: getSslConfig()
});

// The database server runs on UTC; the wheel's day (spin_date, the 3-spins
// limit, plan days, nightly jobs) must turn over at midnight IST, so every
// session uses IST for CURRENT_DATE and friends. Stored timestamps don't change.
const DB_TIMEZONE = process.env.DB_TIMEZONE || 'Asia/Kolkata';
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${DB_TIMEZONE.replace(/'/g, '')}'`).catch((error) => {
    console.error(`Failed to set database time zone to ${DB_TIMEZONE}:`, error.message);
  });
});

export function getDbPool() {
  return pool;
}

export async function runQuery(text, params = []) {
  return pool.query(text, params);
}

export async function runInTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
