import { runInTransaction, runQuery } from './db.js';
import { runRedashQuery } from './redash-client.js';
import { loadRewardConfig } from './reward-config.js';
import { PLAN_MODE_FOR, endFinishedPlans, getRewardEngineMode, insertPlans } from './reward-engine.js';
import { SEGMENTS, planNight } from './reward-planner.js';

// Nightly job of the reward engine v1. Scores every regular payer who spun in
// the last 7 days as of yesterday (IST), recomputes the median and coins per
// share over all of them, and gives a new 5-spin-day plan to those whose plan
// has finished. Running plans are never touched. Also refreshes every player's
// recharge segment (regular / one-time / unpaid).
//
// mode on      -> live plans (served)
// mode dry_run -> shadow plans (drawn on every spin, never served)
// store=false  -> compute and return the summary only (e.g. a July date)

const BATCH_SIZE = 1000;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function fetchFeatureRows(scoringDate) {
  const queryId = process.env.REDASH_REWARD_FEATURES_QUERY_ID;
  if (!queryId) throw new Error('REDASH_REWARD_FEATURES_QUERY_ID is not configured');
  const rows = await runRedashQuery(queryId, { scoring_date: scoringDate });
  // There are always spin-active users; an empty result means a broken query.
  if (rows.length === 0) throw new Error(`Redash query ${queryId} returned 0 users for ${scoringDate}`);
  const missing = ['user_id', 'recharges_30d'].filter((column) => !(column in rows[0]));
  if (missing.length > 0) throw new Error(`Redash query ${queryId} is missing columns: ${missing.join(', ')}`);
  return rows;
}

async function getDates(scoringDate) {
  if (scoringDate) {
    const { rows } = await runQuery('SELECT ($1::date + 1)::text AS start_date', [scoringDate]);
    return { scoringDate, startDate: rows[0].start_date };
  }
  const { rows } = await runQuery(
    "SELECT (CURRENT_DATE - 1)::text AS scoring_date, CURRENT_DATE::text AS start_date"
  );
  return { scoringDate: rows[0].scoring_date, startDate: rows[0].start_date };
}

// Spin-active = spun the wheel in [S-6, S] (game data). They are the players
// who can get a plan tonight.
async function loadSpinActivePlayers(scoringDate) {
  const { rows } = await runQuery(
    `
      SELECT DISTINCT p.id, p.dostt_user_id
      FROM spin_events s
      JOIN players p ON p.id = s.player_id
      WHERE s.spin_date BETWEEN $1::date - 6 AND $1::date
        AND p.dostt_user_id IS NOT NULL
    `,
    [scoringDate]
  );
  return new Map(rows.map((p) => [Number(p.dostt_user_id), p.id]));
}

// Players whose plan is still open and not finished by today keep it.
async function loadRunningDosttIds(planMode, today, cfg) {
  const { rows } = await runQuery(
    `
      SELECT DISTINCT p.dostt_user_id
      FROM reward_plans rp
      JOIN players p ON p.id = rp.player_id
      WHERE rp.mode = $1 AND rp.ended_at IS NULL
        AND NOT (rp.spin_days >= $2 AND rp.last_spin_date < $3::date)
        AND p.dostt_user_id IS NOT NULL
    `,
    [planMode, cfg.plan_days, today]
  );
  return new Set(rows.map((r) => Number(r.dostt_user_id)));
}

// Every player's recharge segment as of tonight: from the payer list, else unpaid.
async function updateSegments(segmentByDosttId) {
  const ids = [...segmentByDosttId.keys()];
  const { rowCount } = await runQuery(
    `
      UPDATE players p
      SET reward_segment = COALESCE(x.segment, $3)
      FROM players p2
      LEFT JOIN unnest($1::int[], $2::text[]) AS x(dostt_user_id, segment) ON x.dostt_user_id = p2.dostt_user_id
      WHERE p.id = p2.id
        AND p2.dostt_user_id IS NOT NULL
        AND p.reward_segment IS DISTINCT FROM COALESCE(x.segment, $3)
    `,
    [ids, ids.map((id) => segmentByDosttId.get(id)), SEGMENTS.unpaid]
  );
  return rowCount;
}

async function startRun({ scoringDate, startDate, mode }) {
  const { rows } = await runQuery(
    `INSERT INTO reward_runs (scoring_date, plan_start_date, mode, status) VALUES ($1, $2, $3, 'running') RETURNING id`,
    [scoringDate, startDate, mode]
  );
  return rows[0].id;
}

async function finishRun(runId, { status, params = null, summary = null, error = null }) {
  try {
    await runQuery(
      `
        UPDATE reward_runs
        SET status = $2, population_size = $3, median_score = $4, coins_per_share = $5, budget_coins = $6,
            new_plans = $7, planned_coins = $8, summary = $9, error = $10, finished_at = NOW()
        WHERE id = $1
      `,
      [
        runId, status, summary?.populationSize ?? null, params?.medianScore ?? null, params?.coinsPerShare ?? null,
        params?.budgetCoins ?? null, summary?.storedPlans ?? null, summary?.plannedCoins ?? null,
        summary ? JSON.stringify(summary) : null, error
      ]
    );
  } catch (recordError) {
    console.error('Failed to record reward run:', recordError.message);
  }
}

export async function getLastSuccessfulScoringRunAt() {
  const { rows } = await runQuery(
    "SELECT MAX(started_at) AS ran_at FROM reward_runs WHERE status = 'success' AND mode = $1",
    [getRewardEngineMode()]
  );
  return rows[0]?.ran_at || null;
}

export async function runRewardScoringJob({ mode = getRewardEngineMode(), scoringDate = null, store = true } = {}) {
  const planMode = PLAN_MODE_FOR[mode];
  if (!planMode) throw new Error(`Reward scoring needs REWARD_ENGINE=dry_run or on (got ${mode})`);

  const cfg = loadRewardConfig();
  const dates = await getDates(scoringDate);
  const runId = store ? await startRun({ ...dates, mode }) : null;

  try {
    const rows = await fetchFeatureRows(dates.scoringDate);
    const playerIdByDosttId = await loadSpinActivePlayers(dates.scoringDate);
    const runningDosttIds = await loadRunningDosttIds(planMode, dates.startDate, cfg);
    const { params, plans, segmentByDosttId, summary } = planNight({
      rows,
      spinActiveDosttIds: new Set(playerIdByDosttId.keys()),
      runningDosttIds,
      playerIdByDosttId,
      cfg
    });

    let storedPlans = 0;
    let endedPlans = 0;
    let segmentsChanged = 0;
    if (store) {
      endedPlans = await runInTransaction((client) => endFinishedPlans(client, planMode, dates.startDate, cfg));
      for (const batch of chunk(plans, BATCH_SIZE)) {
        storedPlans += await runInTransaction((client) =>
          insertPlans(client, batch, { runId, mode: planMode, startDate: dates.startDate, cfg })
        );
      }
      // Decides what a spin does without an open plan (see noPlanAction).
      segmentsChanged = await updateSegments(segmentByDosttId);
    }

    const result = { runId, mode, ...dates, ...summary, endedPlans, storedPlans, segmentsChanged };
    if (store) await finishRun(runId, { status: 'success', params, summary: result });
    return result;
  } catch (error) {
    if (store) await finishRun(runId, { status: 'failed', error: error.message });
    throw error;
  }
}
