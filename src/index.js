import { runQuery } from './db.js';

async function main() {
  const result = await runQuery(
    `
      SELECT reward_key, label, reward_type, coin_value, probability
      FROM rewards
      WHERE is_active = TRUE
      ORDER BY id
    `
  );

  console.log('Available rewards:', result.rows);
}

main().catch((error) => {
  console.error('Demo failed:', error.message);
  process.exit(1);
});
