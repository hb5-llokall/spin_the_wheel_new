import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { runQuery } from '../src/db.js';

dotenv.config();

const sql = readFileSync(new URL('../sql/add_notify_column.sql', import.meta.url), 'utf8');

console.log('Running migration: add notify_user column to transfer_requests...');
await runQuery(sql);
console.log('Migration complete ✓');
process.exit(0);
