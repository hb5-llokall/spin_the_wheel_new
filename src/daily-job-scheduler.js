import { getDbPool } from './db.js';

// Runs an in-app job once a day at a fixed IST time. A Postgres advisory lock
// means only one replica does the work, and on boot the job catches up if its
// last successful run is more than 23h old.

const IST_OFFSET_MINUTES = 330;
const CATCH_UP_AFTER_MS = 23 * 60 * 60 * 1000;

export function parseRunTime(value, fallback = { hour: 2, minute: 0 }) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return fallback;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// IST has no DST, so the next run is just the next wall-clock HH:MM at UTC+5:30.
export function msUntilNextRun({ hour, minute }, now = new Date()) {
  const nowIst = new Date(now.getTime() + IST_OFFSET_MINUTES * 60000);
  const targetIst = new Date(nowIst);
  targetIst.setUTCHours(hour, minute, 0, 0);
  if (targetIst <= nowIst) {
    targetIst.setUTCDate(targetIst.getUTCDate() + 1);
  }
  return targetIst.getTime() - nowIst.getTime();
}

async function runWithLock({ name, lockKey, dryRun, onlyIfStale, run, getLastSuccessfulRunAt }) {
  const client = await getDbPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!rows[0].locked) {
      console.log(`${name}: another instance is running the job, skipping`);
      return;
    }
    try {
      if (onlyIfStale) {
        const lastRunAt = await getLastSuccessfulRunAt();
        if (lastRunAt && Date.now() - new Date(lastRunAt).getTime() < CATCH_UP_AFTER_MS) {
          return;
        }
        console.log(`${name}: last successful run ${lastRunAt || 'never'} — running catch-up now`);
      }
      const summary = await run({ dryRun });
      console.log(`${name} job complete ✓`, summary);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } catch (error) {
    console.error(`${name} job failed:`, error.message);
  } finally {
    client.release();
  }
}

export function startDailyJob({ name, lockKey, runAt, dryRun = false, run, getLastSuccessfulRunAt }) {
  const scheduleNext = () => {
    const delay = msUntilNextRun(runAt);
    console.log(`${name}: next run in ${Math.round(delay / 60000)} min${dryRun ? ' (dry run)' : ''}`);
    setTimeout(async () => {
      await runWithLock({ name, lockKey, dryRun, onlyIfStale: false, run, getLastSuccessfulRunAt });
      scheduleNext();
    }, delay).unref();
  };

  runWithLock({ name, lockKey, dryRun, onlyIfStale: true, run, getLastSuccessfulRunAt });
  scheduleNext();
}
