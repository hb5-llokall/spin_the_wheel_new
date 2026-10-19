import { parseRunTime, startDailyJob } from './daily-job-scheduler.js';
import { getRewardEngineMode } from './reward-engine.js';
import { getLastSuccessfulScoringRunAt, runRewardScoringJob } from './reward-scoring.js';

const ADVISORY_LOCK_KEY = 72931002;

// Runs the nightly reward job when REWARD_ENGINE is dry_run or on.
export function startRewardScoringScheduler() {
  const mode = getRewardEngineMode();
  if (mode === 'off') return;
  if (process.env.REWARD_SCORING_SCHEDULER === 'off') {
    console.log('Reward scoring scheduler disabled (REWARD_SCORING_SCHEDULER=off)');
    return;
  }

  startDailyJob({
    name: `Reward scoring (${mode})`,
    lockKey: ADVISORY_LOCK_KEY,
    runAt: parseRunTime(process.env.REWARD_SCORING_RUN_AT_IST, { hour: 3, minute: 0 }),
    run: () => runRewardScoringJob({ mode }),
    getLastSuccessfulRunAt: getLastSuccessfulScoringRunAt
  });
}
