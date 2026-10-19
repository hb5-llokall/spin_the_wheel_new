import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { runQuery } from '../src/db.js';

dotenv.config();

const sql = readFileSync(new URL('../sql/add_recharge_gate.sql', import.meta.url), 'utf8');

console.log('Running migration: add recharge gate columns to players...');
await runQuery(sql);
console.log('Migration complete ✓');
process.exit(0);
