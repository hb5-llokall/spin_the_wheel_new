import dotenv from 'dotenv';
import { runQuery } from '../db.js';
import { runRedashQuery } from '../redash-client.js';
import { recordRecharge } from './reward-engine.js';

dotenv.config();

// Nightly job for the reward engine:
// 1. (optional) pulls recent recharges from Redash and starts paid cycles
// 2. scores every player from game data and assigns a segment (stored for
//    analysis and the admin dashboard; decks don't depend on it yet)

// Segment thresholds, phase 1 (game data only).
const AT_RISK_MIN_GAP_DAYS = 3;
const HOARDER_MIN_COINS = 30;
const ENGAGED_MIN_DAYS_14D = 4;
const SINGLE_SPINNER_MAX_AVG = 1.5;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// The Redash query takes no parameters and returns recent recharges with
// columns user_id, recharge_id, amount (₹), recharged_at and optionally coins
// and refunded. Re-running it is safe: recharge_id dedupes.
async function syncRecharges({ dryRun }) {
  const queryId = process.env.REDASH_RECHARGE_QUERY_ID;
  if (!queryId) return { skipped: 'REDASH_RECHARGE_QUERY_ID not set' };

  const rows = await runRedashQuery(queryId);
  const required = ['user_id', 'recharge_id', 'amount', 'recharged_at'];
  const missing = rows.length > 0 ? required.filter((column) => !(column in rows[0])) : [];
  if (missing.length > 0) {
    throw new Error(`Redash query ${queryId} is missing columns: ${missing.join(', ')}`);
  }

  const counts = { rows: rows.length };
  if (dryRun) return counts;

  for (const row of rows) {
    const result = await recordRecharge({
      dosttUserId: Number(row.user_id),
      externalId: String(row.recharge_id),
      amountRupees: Number(row.amount),
      coins: row.coins != null ? Number(row.coins) : null,
      rechargedAt: row.recharged_at,
      refunded: row.refunded === true || row.refunded === 'true',
      source: 'redash'
    });
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  return counts;
}

function segmentFor(p) {
  const atRisk = p.days_since_last_spin > Math.max(AT_RISK_MIN_GAP_DAYS, 2 * (Number(p.usual_gap_days) || 0));
  if (p.days_played <= 1) return 'new';
  if (p.is_payer) return atRisk ? 'payer_at_risk' : 'payer_steady';
  if (atRisk) return 'at_risk';
  if (p.coins_won >= HOARDER_MIN_COINS && p.coins_transferred === 0) return 'hoarder';
  if (p.days_played_14d >= ENGAGED_MIN_DAYS_14D) return 'engaged_non_payer';
  return 'casual';
}

async function scorePlayers() {
  const { rows } = await runQuery(`
    WITH days AS (
      SELECT player_id, spin_date, COUNT(*) AS spins
      FROM spin_events
      GROUP BY player_id, spin_date
    ),
    agg AS (
      SELECT player_id,
             COUNT(*)::int AS days_played,
             (COUNT(*) FILTER (WHERE spin_date >= CURRENT_DATE - 13))::int AS days_played_14d,
             ROUND(AVG(spins), 2) AS avg_spins_per_day,
             (CURRENT_DATE - MAX(spin_date))::int AS days_since_last_spin,
             ROUND((MAX(spin_date) - MIN(spin_date))::numeric / NULLIF(COUNT(*) - 1, 0), 2) AS usual_gap_days
      FROM days
      GROUP BY player_id
    ),
    xfer AS (
      SELECT player_id, SUM(coins_requested)::int AS coins_transferred
      FROM transfer_requests
      WHERE status IN ('submitted', 'success', 'mock_success')
      GROUP BY player_id
    )
    SELECT p.id, p.is_payer, p.total_coins::int AS coins_won,
           COALESCE(x.coins_transferred, 0) AS coins_transferred,
           a.days_played, a.days_played_14d, a.avg_spins_per_day,
           a.days_since_last_spin, a.usual_gap_days
    FROM players p
    JOIN agg a ON a.player_id = p.id
    LEFT JOIN xfer x ON x.player_id = p.id
  `);

  return rows.map((p) => ({
    ...p,
    segment: segmentFor(p),
    single_spinner: p.days_played >= 2 && Number(p.avg_spins_per_day) < SINGLE_SPINNER_MAX_AVG
  }));
}

async function writeScores(scores) {
  for (const batch of chunk(scores, 1000)) {
    await runQuery(
      `
        INSERT INTO player_scores (player_id, segment, days_played, days_played_14d, avg_spins_per_day,
                                   days_since_last_spin, usual_gap_days, coins_won, coins_transferred,
                                   single_spinner, computed_at)
        SELECT *, NOW() FROM unnest($1::bigint[], $2::text[], $3::int[], $4::int[], $5::numeric[],
                                    $6::int[], $7::numeric[], $8::int[], $9::int[], $10::boolean[])
        ON CONFLICT (player_id) DO UPDATE SET
          segment = EXCLUDED.segment,
          days_played = EXCLUDED.days_played,
          days_played_14d = EXCLUDED.days_played_14d,
          avg_spins_per_day = EXCLUDED.avg_spins_per_day,
          days_since_last_spin = EXCLUDED.days_since_last_spin,
          usual_gap_days = EXCLUDED.usual_gap_days,
          coins_won = EXCLUDED.coins_won,
          coins_transferred = EXCLUDED.coins_transferred,
          single_spinner = EXCLUDED.single_spinner,
          computed_at = NOW()
      `,
      [
        batch.map((s) => s.id),
        batch.map((s) => s.segment),
        batch.map((s) => s.days_played),
        batch.map((s) => s.days_played_14d),
        batch.map((s) => s.avg_spins_per_day),
        batch.map((s) => s.days_since_last_spin),
        batch.map((s) => s.usual_gap_days),
        batch.map((s) => s.coins_won),
        batch.map((s) => s.coins_transferred),
        batch.map((s) => s.single_spinner)
      ]
    );
  }
}

async function recordRun({ status, dryRun, summary = null, error = null }) {
  try {
    await runQuery(
      'INSERT INTO reward_scoring_runs (status, dry_run, summary, error) VALUES ($1, $2, $3, $4)',
      [status, dryRun, summary ? JSON.stringify(summary) : null, error]
    );
  } catch (recordError) {
    console.error('Failed to record reward scoring run:', recordError.message);
  }
}

export async function getLastSuccessfulScoringRunAt() {
  const { rows } = await runQuery(
    "SELECT MAX(ran_at) AS ran_at FROM reward_scoring_runs WHERE status = 'success' AND dry_run = FALSE"
  );
  return rows[0]?.ran_at || null;
}

export async function runRewardScoringJob({ dryRun = false } = {}) {
  try {
    const recharges = await syncRecharges({ dryRun });
    const scores = await scorePlayers();

    const segments = {};
    for (const s of scores) segments[s.segment] = (segments[s.segment] || 0) + 1;

    const summary = {
      recharges,
      playersScored: scores.length,
      segments,
      singleSpinners: scores.filter((s) => s.single_spinner).length
    };

    if (!dryRun) {
      await writeScores(scores);
    }

    await recordRun({ status: 'success', dryRun, summary });
    return summary;
  } catch (error) {
    await recordRun({ status: 'failed', dryRun, error: error.message });
    throw error;
  }
}
