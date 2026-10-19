import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { runQuery } from '../src/db.js';

dotenv.config();

// node scripts/add-reward-plan-tables.js         creates the reward engine v1 tables
// node scripts/add-reward-plan-tables.js --down  drops them again (deletes all plans)
const down = process.argv.includes('--down');
const file = down ? '../sql/drop_reward_plans.sql' : '../sql/add_reward_plans.sql';
const sql = readFileSync(new URL(file, import.meta.url), 'utf8');

console.log(`Running migration: ${down ? 'drop' : 'add'} reward plan tables...`);
await runQuery(sql);
console.log('Migration complete ✓');
process.exit(0);
