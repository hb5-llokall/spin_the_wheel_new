import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REWARD_CONFIG as CFG } from '../src/reward-config.js';
import { ARMS, BETTER_LUCK, arm, buildDeck, planCards, representableAmounts } from '../src/reward-logic.js';
import {
  SEGMENTS, deckForUnscored, featuresFromRow, isPlanFinished, noPlanAction, planDayForSpin, planNight, segmentOf
} from '../src/reward-planner.js';

const REPRESENTABLE = representableAmounts();

// A Redash row as sql/redash/reward_features_bq.sql returns it (numbers may come back as strings).
function row(userId, overrides = {}) {
  return {
    user_id: userId, recharges_30d: 3, median_recharge_rs: '149', days_since_last_recharge: 2,
    usual_gap_days: 2, last_pack_coins: 300, prev_pack_coins: 300, offer_share: 0.5,
    minutes_this_week: 30, minutes_last_week: 30, video_minutes_this_week: 0, max_calls_same_listener: 1,
    unfinished_payment_attempts: 0, ran_out_calls: 0, platform_onboarded: 'android',
    country_onboarded: 'India', account_age_days: 120, ...overrides
  };
}

// Population with a spread of scores: vary minutes, attempts and recharges.
function population(n, startId = 1000) {
  return Array.from({ length: n }, (_, i) => row(startId + i, {
    minutes_this_week: [0, 10, 30, 90, 200][i % 5],
    unfinished_payment_attempts: [0, 1, 2][i % 3],
    recharges_30d: [2, 3, 5, 10][i % 4],
    median_recharge_rs: [40, 120, 300, 900][i % 4]
  }));
}

const allKnown = (rows) => new Map(rows.map((r) => [Number(r.user_id), Number(r.user_id) + 1]));
// Everyone in rows spun this week and is known to the wheel, unless overridden.
const plan = (rows, extra = {}) => planNight({
  rows,
  spinActiveDosttIds: new Set(rows.map((r) => Number(r.user_id))),
  runningDosttIds: new Set(),
  playerIdByDosttId: allKnown(rows),
  ...extra
});

test('segments: 2+ recharges regular, 1 one-time, 0 unpaid', () => {
  assert.equal(segmentOf({ recharges_30d: 0 }), SEGMENTS.unpaid);
  assert.equal(segmentOf({ recharges_30d: null }), SEGMENTS.unpaid);
  assert.equal(segmentOf({ recharges_30d: '1' }), SEGMENTS.oneTime);
  assert.equal(segmentOf({ recharges_30d: 2 }), SEGMENTS.regular);
});

test('features: nulls, platform, country and GST', () => {
  const f = featuresFromRow(row(1, {
    minutes_this_week: null, last_pack_coins: null, platform_onboarded: 'iOS 17', country_onboarded: 'UAE'
  }));
  assert.equal(f.minutesThisWeek, 0);
  assert.equal(f.lastPackCoins, null);
  assert.equal(f.isIos, true);
  assert.equal(f.isInternational, true);
  assert.equal(f.medianRechargeRs, 149);
  assert.equal(featuresFromRow(row(1, { country_onboarded: null })).isInternational, false);
  assert.equal(featuresFromRow(row(1, { country_onboarded: 'india' })).isInternational, false);
  assert.equal(featuresFromRow(row(1), { ...CFG, gst_divisor: 1.18 }).medianRechargeRs, 149 / 1.18);
});

test('only regular payers who spun this week are scored; segments cover all spin-active users', () => {
  const rows = [...population(20), row(1, { recharges_30d: 1 }), row(5, { recharges_30d: 4 })];
  const spinActive = new Set([...population(20).map((r) => r.user_id), 1, 2, 3]); // 2, 3: spun, never paid; 5: paid, didn't spin
  const { plans, summary, segmentByDosttId } = plan(rows, { spinActiveDosttIds: spinActive });
  assert.equal(summary.populationSize, 20);
  assert.deepEqual(summary.segments, { regular_payer: 20, one_time_payer: 1, unpaid: 2 });
  assert.equal(plans.length, 20);
  assert.ok(plans.every((p) => p.segment === SEGMENTS.regular));
  assert.ok(!plans.some((p) => p.dosttUserId === 5));
  assert.equal(segmentByDosttId.get(5), SEGMENTS.regular); // segment still recorded for when they come back
  assert.equal(segmentByDosttId.get(1), SEGMENTS.oneTime);
  assert.equal(segmentByDosttId.has(2), false); // not a payer: unpaid
});

test('running plans are never replaced; unknown players are skipped', () => {
  const rows = population(30);
  const running = new Set([1000, 1001, 1002]);
  const known = allKnown(rows);
  known.delete(1003);
  const { plans, summary } = plan(rows, { runningDosttIds: running, playerIdByDosttId: known });
  const planned = new Set(plans.map((p) => p.dosttUserId));
  for (const id of [1000, 1001, 1002, 1003]) assert.ok(!planned.has(id));
  assert.equal(summary.skippedRunning, 3);
  assert.equal(summary.skippedUnknownPlayer, 1);
  assert.equal(plans.length, 26);
});

test('median and coins per share come from the whole population, not only tonight', () => {
  const rows = population(50);
  const all = plan(rows);
  const few = plan(rows, { runningDosttIds: new Set(rows.slice(0, 40).map((r) => r.user_id)) });
  assert.equal(few.params.medianScore, all.params.medianScore);
  assert.equal(few.params.coinsPerShare, all.params.coinsPerShare);
  const byId = new Map(all.plans.map((p) => [p.dosttUserId, p]));
  for (const p of few.plans) assert.equal(p.scoredCoins, byId.get(p.dosttUserId).scoredCoins);
});

test('population stays within ±3% of 90 coins per user', () => {
  const rows = population(997);
  const { summary } = plan(rows, { cfg: { ...CFG, daily_cap_coins_per_plan: null } });
  assert.ok(Math.abs(summary.populationVsBudgetPct) < 3, `${summary.populationVsBudgetPct}%`);
  assert.equal(summary.budgetCoins, 90 * 997);
});

test('no holdout by default: every regular payer gets a makeable scored deck', () => {
  const rows = population(400);
  const { plans, summary } = plan(rows, { cfg: { ...CFG, daily_cap_coins_per_plan: null } });
  for (const p of plans) {
    assert.equal(p.arm, ARMS.treatment);
    assert.deepEqual(p.deck, buildDeck(p.scoredCoins));
    assert.ok(p.deck.every((d) => REPRESENTABLE.has(d)));
    assert.ok(p.scores.total >= 0 && p.scores.total <= 100);
    assert.equal(p.engineVersion, 'spin_reward_v1');
  }
  assert.deepEqual(summary.arms, { [ARMS.treatment]: 400 });
});

test('an in-wheel holdout, if enabled, gets the legacy deck and the arm is stored', () => {
  const rows = population(400);
  const { plans } = plan(rows, { cfg: { ...CFG, holdout_pct: 10, daily_cap_coins_per_plan: null } });
  const holdout = plans.filter((p) => p.arm === ARMS.holdout);
  assert.ok(holdout.length > 0);
  for (const p of plans) assert.equal(p.arm, arm(p.dosttUserId, 10));
  for (const p of holdout) assert.deepEqual(p.deck, CFG.legacy_deck);
});

test('daily cap: tonight\'s scored plans average at most 90 coins, decks stay makeable', () => {
  // Only users near the median tonight (the rest still running): above 90 on average.
  const rows = population(200);
  const free = plan(rows, { cfg: { ...CFG, daily_cap_coins_per_plan: null } });
  const generous = free.plans.filter((p) => p.totalCoins > 90).map((p) => p.dosttUserId);
  const running = new Set(rows.map((r) => r.user_id).filter((id) => !generous.includes(id)));
  const capped = plan(rows, { runningDosttIds: running });
  const total = capped.plans.reduce((s, p) => s + p.totalCoins, 0);
  assert.ok(capped.plans.length > 0);
  assert.equal(capped.summary.dailyCap.capped, true);
  assert.equal(capped.summary.dailyCap.capCoins, 90 * capped.plans.length);
  assert.ok(total <= 90 * capped.plans.length, `${total} > ${90 * capped.plans.length}`);
  for (const p of capped.plans) assert.ok(p.deck.every((d) => REPRESENTABLE.has(d)));
});

test('no regular payers: nothing planned', () => {
  const rows = [row(1, { recharges_30d: 1 })];
  const { plans, params } = plan(rows);
  assert.equal(params, null);
  assert.equal(plans.length, 0);
});

test('plan cards: 3 per day, same cards for the same plan id, only winnable prizes', () => {
  for (const deck of [CFG.legacy_deck, buildDeck(130), buildDeck(600), buildDeck(10)]) {
    const cards = planCards(deck, '42');
    assert.deepEqual(cards, planCards(deck, '42'));
    assert.equal(cards.length, 5);
    cards.forEach((day, i) => {
      assert.equal(day.length, 3);
      assert.equal(day.filter((c) => c !== BETTER_LUCK).reduce((a, b) => a + b, 0), deck[i]);
      assert.ok(day.every((c) => c === BETTER_LUCK || CFG.prizes.includes(c)));
    });
  }
});

// ─── Spin-day plans and what a spin does without a plan ──────────────────────

test('plan days count spin days, not calendar days', () => {
  const fresh = { spinDays: 0, lastSpinDate: null };
  assert.equal(planDayForSpin(fresh, '2026-10-01'), 1);
  assert.equal(planDayForSpin({ spinDays: 1, lastSpinDate: '2026-10-01' }, '2026-10-01'), 1); // same day
  assert.equal(planDayForSpin({ spinDays: 1, lastSpinDate: '2026-10-01' }, '2026-10-20'), 2); // 19 days later: still day 2
  assert.equal(planDayForSpin({ spinDays: 4, lastSpinDate: '2026-10-05' }, '2026-10-09'), 5);
});

test('a plan finishes only after its 5th spin day is over', () => {
  assert.equal(isPlanFinished({ spinDays: 4, lastSpinDate: '2026-10-01' }, '2026-12-01'), false);
  assert.equal(isPlanFinished({ spinDays: 5, lastSpinDate: '2026-10-05' }, '2026-10-05'), false); // still day 5
  assert.equal(isPlanFinished({ spinDays: 5, lastSpinDate: '2026-10-05' }, '2026-10-06'), true);
  assert.equal(isPlanFinished({ spinDays: 0, lastSpinDate: null }, '2026-10-06'), false);
});

test('spin-time decks: unpaid, new and one-time payers all get 15·15·10·25·25', () => {
  assert.deepEqual(deckForUnscored(SEGMENTS.unpaid), [15, 15, 10, 25, 25]);
  assert.deepEqual(deckForUnscored(null), [15, 15, 10, 25, 25]);
  assert.deepEqual(deckForUnscored(SEGMENTS.oneTime), [15, 15, 10, 25, 25]);
  const cards = planCards(deckForUnscored(SEGMENTS.unpaid), '9');
  assert.deepEqual(cards.map((day) => day.filter((c) => c !== BETTER_LUCK).reduce((a, b) => a + b, 0)), [15, 15, 10, 25, 25]);
  assert.ok(cards.every((day) => day[0] !== BETTER_LUCK)); // first spin of each day wins
});

test('no open plan: regular waits, one-time gets a new plan, unpaid one trial then waits', () => {
  assert.equal(noPlanAction({ segment: SEGMENTS.regular, hadPlanBefore: false }), 'wait');
  assert.equal(noPlanAction({ segment: SEGMENTS.regular, hadPlanBefore: true }), 'wait');
  assert.equal(noPlanAction({ segment: SEGMENTS.oneTime, hadPlanBefore: true }), 'legacy');
  assert.equal(noPlanAction({ segment: SEGMENTS.unpaid, hadPlanBefore: false }), 'legacy');
  assert.equal(noPlanAction({ segment: SEGMENTS.unpaid, hadPlanBefore: true }), 'wait');
  assert.equal(noPlanAction({ segment: null, hadPlanBefore: false }), 'legacy'); // brand-new user
  assert.equal(noPlanAction({ segment: null, hadPlanBefore: true }), 'wait');
});
