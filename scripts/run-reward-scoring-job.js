import dotenv from 'dotenv';
import { runRewardScoringJob } from '../src/reward-scoring.js';

dotenv.config();

// npm run job:reward-scoring                     runs tonight's job in the REWARD_ENGINE mode
// npm run job:reward-scoring:dry                 same, but stores shadow plans (dry run)
// ... -- --date 2026-07-31 --report-only          scores a past date, stores nothing, prints the summary
const args = process.argv.slice(2);
const dateIndex = args.indexOf('--date');
const options = {
  scoringDate: dateIndex >= 0 ? args[dateIndex + 1] : null,
  store: !args.includes('--report-only')
};
if (args.includes('--dry-run')) options.mode = 'dry_run';
else if (!options.store && !['dry_run', 'on'].includes(process.env.REWARD_ENGINE)) options.mode = 'dry_run';

runRewardScoringJob(options)
  .then((summary) => {
    console.log('Reward scoring job complete ✓', JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error('Reward scoring job failed:', error.message);
    process.exit(1);
  });
