// All tunable numbers of the personalised reward engine (SPEC §3–§6), in one
// place. Override any of them with REWARD_CONFIG_JSON, e.g.
//   REWARD_CONFIG_JSON='{"high_floor":0.15,"daily_cap_coins_per_plan":null}'

export const DEFAULT_REWARD_CONFIG = Object.freeze({
  budget_coins_per_user: 90,          // same total as today's wheel (10+10+10+10+50)
  low_range: 96,                      // below median: share = 1 - (median - score)/96
  low_floor: 0.2,
  high_range: 25,                     // above median: share = 1 - (score - median)/25
  high_floor: 0.1,
  min_coins: 10,
  max_coins: 600,
  round_to: 5,
  deck_weights: [0.10, 0.15, 0.20, 0.25],   // day 5 gets the rest
  prizes: [10, 15, 20, 50],                 // winnable prizes in regular plans
  max_wins_per_day: 3,
  plan_days: 5,
  // Holdout users never see the wheel (app-level experiment), so nobody who spins
  // is held out here. Kept as a setting in case an in-wheel holdout is wanted later.
  holdout_pct: 0,
  legacy_deck: [10, 10, 10, 10, 50],        // today's wheel: only an in-wheel holdout, if enabled
  standard_deck: [15, 15, 10, 25, 25],      // everyone not scored: unpaid, brand-new and one-time payers
  // Tonight's new scored plans may total at most this × their number (90 = the
  // old standard); above that they are scaled down proportionally. null = no cap.
  daily_cap_coins_per_plan: 90,
  gst_divisor: 1                            // recharge amount / this = ex-GST amount (1 = as the July SQL)
});

export function loadRewardConfig(env = process.env) {
  if (!env.REWARD_CONFIG_JSON) return DEFAULT_REWARD_CONFIG;
  const overrides = JSON.parse(env.REWARD_CONFIG_JSON);
  const unknown = Object.keys(overrides).filter((key) => !(key in DEFAULT_REWARD_CONFIG));
  if (unknown.length > 0) {
    throw new Error(`REWARD_CONFIG_JSON has unknown keys: ${unknown.join(', ')}`);
  }
  return Object.freeze({ ...DEFAULT_REWARD_CONFIG, ...overrides });
}
