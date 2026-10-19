import { parseRunTime, startDailyJob } from './daily-job-scheduler.js';
import { runRechargeGateJob, getLastSuccessfulRunAt } from './recharge-gate.js';

// Arbitrary constant; any pod holding it is the one running the job, so with
// several replicas only one of them does the work each night.
const ADVISORY_LOCK_KEY = 72931001;

export function startRechargeGateScheduler() {
  if (process.env.RECHARGE_GATE_SCHEDULER === 'off') {
    console.log('Recharge gate scheduler disabled (RECHARGE_GATE_SCHEDULER=off)');
    return;
  }
  if (!process.env.REDASH_ELIGIBILITY_QUERY_ID) {
    console.log('Recharge gate scheduler not started — REDASH_ELIGIBILITY_QUERY_ID is not set');
    return;
  }

  startDailyJob({
    name: 'Recharge gate',
    lockKey: ADVISORY_LOCK_KEY,
    runAt: parseRunTime(process.env.RECHARGE_GATE_RUN_AT_IST),
    dryRun: process.env.RECHARGE_GATE_DRY_RUN === 'true',
    run: runRechargeGateJob,
    getLastSuccessfulRunAt
  });
}
