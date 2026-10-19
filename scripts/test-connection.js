import { runQuery } from '../src/db.js';

async function main() {
  const result = await runQuery('SELECT NOW() AS current_time, current_database() AS database_name');
  console.log('Database connection successful:', result.rows[0]);
}

main().catch((error) => {
  console.error('Connection test failed:', error.message);
  process.exit(1);
});
