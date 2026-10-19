import dotenv from 'dotenv';
import { runRechargeGateJob } from '../src/recharge-gate.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');

runRechargeGateJob({ dryRun })
  .then((summary) => {
    console.log('Recharge gate job complete ✓', summary);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Recharge gate job failed:', error.message);
    process.exit(1);
  });
