import { DEFAULT_REWARD_CONFIG } from './reward-config.js';
import {
  ARMS, ENGINE_VERSION, applyDailyCap, arm, buildDeck, populationParams, scoreUser, share, totalCoins
} from './reward-logic.js';

// Pure nightly planning (no I/O): Redash feature rows in, plans to store out.
// The DB side lives in reward-scoring.js.

export const SEGMENTS = {
  regular: 'regular_payer',
  oneTime: 'one_time_payer',
  unpaid: 'unpaid'
};

// Which segments are scored. Others get the legacy deck; add a segment here
// (with its own scoring) to give it personalised plans later.
const SCORED_SEGMENTS = new Set([SEGMENTS.regular]);

export function segmentOf(row) {
  const n = Number(row.recharges_30d) || 0;
  if (n >= 2) return SEGMENTS.regular;
  if (n === 1) return SEGMENTS.oneTime;
  return SEGMENTS.unpaid;
}

/**
 * What a spin does when the player has no open plan (pure).
 *   regular payer      -> 'wait'   Better Luck until tonight's scored plan
 *   one-time payer     -> 'legacy' a new 15·15·10·25·25 plan
 *   unpaid / unknown   -> 'legacy' once (the trial); after it, 'wait':
 *                         Better Luck until they recharge (the nightly job
 *                         then moves them to a payer segment)
 */
export function noPlanAction({ segment, hadPlanBefore }) {
  if (segment === SEGMENTS.regular) return 'wait';
  if (segment === SEGMENTS.oneTime) return 'legacy';
  return hadPlanBefore ? 'wait' : 'legacy';
}

// Fixed deck for a plan given at spin time (unpaid, brand-new and one-time
// payers): standard_deck. Kept as a function so a segment can get its own later.
export function deckForUnscored(_segment, cfg = DEFAULT_REWARD_CONFIG) {
  return [...cfg.standard_deck];
}

// A plan lasts plan_days SPIN days (days the player spun, not calendar days):
// day 1 is the first day they spin on it. It is finished once its last spin
// day is over. Pure; dates are 'YYYY-MM-DD'.
export function isPlanFinished({ spinDays, lastSpinDate }, today, cfg = DEFAULT_REWARD_CONFIG) {
  return spinDays >= cfg.plan_days && lastSpinDate != null && lastSpinDate < today;
}

// The plan day a spin today draws from (1-based), counting today if it is a new spin day.
export function planDayForSpin({ spinDays, lastSpinDate }, today) {
  return lastSpinDate === today ? spinDays : spinDays + 1;
}

const num = (value) => (value == null || value === '' ? 0 : Number(value));
const numOrNull = (value) => (value == null || value === '' ? null : Number(value));

// One Redash row (sql/redash/reward_features_bq.sql) -> Features for scoreUser.
export function featuresFromRow(row, cfg = DEFAULT_REWARD_CONFIG) {
  const platform = String(row.platform_onboarded || '').toLowerCase();
  const country = row.country_onboarded == null ? '' : String(row.country_onboarded).toLowerCase();
  return {
    recharges30d: num(row.recharges_30d),
    medianRechargeRs: num(row.median_recharge_rs) / cfg.gst_divisor,
    daysSinceLastRecharge: num(row.days_since_last_recharge),
    usualGapDays: num(row.usual_gap_days),
    lastPackCoins: numOrNull(row.last_pack_coins),
    prevPackCoins: numOrNull(row.prev_pack_coins),
    offerShare: num(row.offer_share),
    minutesThisWeek: num(row.minutes_this_week),
    minutesLastWeek: num(row.minutes_last_week),
    videoMinutesThisWeek: num(row.video_minutes_this_week),
    maxCallsSameListener: num(row.max_calls_same_listener),
    unfinishedPaymentAttempts: num(row.unfinished_payment_attempts),
    ranOutCalls: num(row.ran_out_calls),
    isIos: platform.startsWith('ios'),
    isInternational: country !== '' && country !== 'india',
    accountAgeDays: num(row.account_age_days)
  };
}

function scoreBand(score) {
  if (score >= 80) return '80+';
  const low = Math.floor(score / 10) * 10;
  return `${low}-${low + 9}`;
}

const sum = (values) => values.reduce((total, v) => total + v, 0);

/**
 * Plans tonight's run.
 *  rows              Redash rows: every Dostt user who recharged in [S-29, S], with features
 *  spinActiveDosttIds users who spun the wheel in [S-6, S] (game data)
 *  runningDosttIds   users whose plan has not finished (they keep it untouched)
 *  playerIdByDosttId users known to the wheel (players.dostt_user_id -> players.id)
 * Returns the population params, the new plans to store, each payer's segment
 * and a run summary.
 */
export function planNight({ rows, spinActiveDosttIds, runningDosttIds, playerIdByDosttId, cfg = DEFAULT_REWARD_CONFIG }) {
  const segmentByDosttId = new Map(rows.map((row) => [Number(row.user_id), segmentOf(row)]));
  const segmentCounts = {};
  for (const userId of spinActiveDosttIds) {
    const segment = segmentByDosttId.get(userId) || SEGMENTS.unpaid;
    segmentCounts[segment] = (segmentCounts[segment] || 0) + 1;
  }

  const population = [];
  for (const row of rows) {
    const userId = Number(row.user_id);
    const segment = segmentByDosttId.get(userId);
    if (!spinActiveDosttIds.has(userId) || !SCORED_SEGMENTS.has(segment)) continue;
    const features = featuresFromRow(row, cfg);
    population.push({ userId, segment, features, scores: scoreUser(features) });
  }

  if (population.length === 0) {
    return {
      params: null,
      plans: [],
      segmentByDosttId,
      summary: { segments: segmentCounts, populationSize: 0, newPlans: 0, plannedCoins: 0 }
    };
  }

  // Median and coins per share always come from the WHOLE population.
  const params = populationParams(population.map((u) => u.scores.total), cfg);
  for (const u of population) {
    u.share = share(u.scores.total, params.medianScore, cfg);
    u.totalCoins = totalCoins(u.scores.total, params, cfg);
    u.arm = arm(u.userId, cfg.holdout_pct);
  }

  // Only users with no running plan get a new one; skip users the wheel doesn't know.
  let skippedRunning = 0;
  let skippedUnknown = 0;
  const due = population.filter((u) => {
    if (runningDosttIds.has(u.userId)) { skippedRunning += 1; return false; }
    if (!playerIdByDosttId.has(u.userId)) { skippedUnknown += 1; return false; }
    return true;
  });

  // Daily cap on tonight's scored plans: at most daily_cap_coins_per_plan each on
  // average (a holdout, if ever enabled, keeps the fixed legacy deck).
  const treated = due.filter((u) => u.arm === ARMS.treatment);
  const capCoins = cfg.daily_cap_coins_per_plan == null ? null : cfg.daily_cap_coins_per_plan * treated.length;
  const cap = applyDailyCap(treated.map((u) => u.totalCoins), capCoins, cfg);
  treated.forEach((u, i) => { u.plannedCoins = cap.totals[i]; });

  const legacyTotal = sum(cfg.legacy_deck);
  const plans = due.map((u) => {
    const holdout = u.arm === ARMS.holdout;
    const deck = holdout ? [...cfg.legacy_deck] : buildDeck(u.plannedCoins, cfg);
    return {
      playerId: playerIdByDosttId.get(u.userId),
      dosttUserId: u.userId,
      segment: u.segment,
      arm: u.arm,
      features: u.features,
      scores: u.scores,
      medianScore: params.medianScore,
      share: u.share,
      coinsPerShare: params.coinsPerShare,
      scoredCoins: u.totalCoins,
      totalCoins: holdout ? legacyTotal : sum(deck),
      deck,
      engineVersion: ENGINE_VERSION
    };
  });

  // Population view: what everyone would get tonight (budget check, bands).
  const populationCoins = sum(population.map((u) => u.totalCoins));
  const bands = {};
  for (const u of population) {
    const band = scoreBand(u.scores.total);
    bands[band] = bands[band] || { users: 0, coins: 0 };
    bands[band].users += 1;
    bands[band].coins += u.totalCoins;
  }
  const arms = {};
  for (const p of plans) arms[p.arm] = (arms[p.arm] || 0) + 1;

  const plannedCoins = sum(plans.map((p) => p.totalCoins));
  return {
    params,
    plans,
    segmentByDosttId,
    summary: {
      segments: segmentCounts,
      populationSize: population.length,
      medianScore: params.medianScore,
      coinsPerShare: Number(params.coinsPerShare.toFixed(4)),
      budgetCoins: params.budgetCoins,
      populationCoins,
      populationVsBudgetPct: Number(((populationCoins / params.budgetCoins - 1) * 100).toFixed(2)),
      coinsByScoreBand: bands,
      newPlans: plans.length,
      skippedRunning,
      skippedUnknownPlayer: skippedUnknown,
      plannedCoins,
      plannedBudgetCoins: cfg.budget_coins_per_user * plans.length,
      arms,
      dailyCap: { capCoins, capped: cap.capped, scale: Number(cap.scale.toFixed(4)) }
    }
  };
}
