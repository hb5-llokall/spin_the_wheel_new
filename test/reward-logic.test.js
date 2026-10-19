import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { DEFAULT_REWARD_CONFIG as CFG, loadRewardConfig } from '../src/reward-config.js';
import {
  ARMS, BETTER_LUCK, applyDailyCap, arm, buildDeck, callsPoints, dayCards, median, moneyPoints,
  populationParams, prizesForDay, profilePoints, representableAmounts, roundHalfEven, scoreUser,
  share, shoppingPoints, totalCoins, walletPoints
} from '../src/reward-logic.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const REPRESENTABLE = representableAmounts();

// A regular payer with every factor at its "zero" level.
const base = Object.freeze({
  recharges30d: 2, medianRechargeRs: 10, daysSinceLastRecharge: 100, usualGapDays: 1,
  lastPackCoins: null, prevPackCoins: null, offerShare: 1,
  minutesThisWeek: 0, minutesLastWeek: 0, videoMinutesThisWeek: 0, maxCallsSameListener: 0,
  unfinishedPaymentAttempts: 0, ranOutCalls: 0, isIos: false, isInternational: false, accountAgeDays: 0
});
const f = (overrides) => ({ ...base, ...overrides });

// ─── Ported from reference_python/test_reward_logic_reference.py ─────────────

test('golden share and coins', () => {
  const [header, ...lines] = read('../docs/spin_reward_handoff/examples/golden_share_and_coins.csv').trim().split(/\r?\n/);
  const cols = header.split(',');
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const r = Object.fromEntries(line.split(',').map((v, i) => [cols[i], Number(v)]));
    assert.ok(Math.abs(share(r.total_score, r.median_score) - r.expected_share) < 1e-3, line);
    const params = { medianScore: r.median_score, coinsPerShare: r.coins_per_share };
    assert.equal(totalCoins(r.total_score, params), r.expected_total_coins, line);
  }
});

test('median gets the most', () => {
  const params = { medianScore: 46, coinsPerShare: 131 };
  const top = totalCoins(46, params);
  for (let s = 0; s <= 100; s += 1) assert.ok(totalCoins(s, params) <= top);
});

test('lower side gets more than higher side at the same distance', () => {
  for (let d = 1; d <= 45; d += 1) assert.ok(share(46 - d, 46) >= share(46 + d, 46));
});

test('budget neutral within 3%', () => {
  const scores = [
    ...Array(50).fill(10), ...Array(120).fill(30), ...Array(200).fill(46),
    ...Array(150).fill(55), ...Array(40).fill(70), ...Array(5).fill(90)
  ];
  const p = populationParams(scores);
  const given = scores.reduce((sum, s) => sum + totalCoins(s, p), 0);
  assert.ok(Math.abs(given / p.budgetCoins - 1) < 0.03);
});

test('every total 10–600 gives a makeable 5-day deck', () => {
  for (let total = CFG.min_coins; total <= CFG.max_coins; total += 5) {
    const days = buildDeck(total);
    assert.equal(days.length, 5);
    assert.ok(days.every((d) => REPRESENTABLE.has(d)), `${total}: ${days}`);
    const lost = total - days.reduce((a, b) => a + b, 0);
    assert.ok(lost >= 0 && lost <= 5, `${total}: lost ${lost}`);
    for (const d of days) {
      const prizes = prizesForDay(d);
      assert.equal(prizes.reduce((a, b) => a + b, 0), d);
      assert.ok(prizes.length <= 3);
      assert.ok(prizes.every((p) => CFG.prizes.includes(p)));
    }
  }
});

test('cards are stable and hold the right prizes', () => {
  assert.deepEqual(dayCards(45, 'plan-1', 3), dayCards(45, 'plan-1', 3));
  assert.deepEqual(dayCards(45, 'plan-1', 3).filter((c) => c !== BETTER_LUCK).sort((a, b) => a - b), [10, 15, 20]);
  assert.equal(dayCards(0, 'plan-1', 1).length, 3);
  assert.ok(dayCards(0, 'plan-1', 1).every((c) => c === BETTER_LUCK));
});

test('every day\'s wins come before its Better Luck cards', () => {
  for (let amount = 10; amount <= 150; amount += 5) {
    if (!REPRESENTABLE.has(amount)) continue;
    for (const planId of ['1', '2', '77', '12345']) {
      const cards = dayCards(amount, planId, 3);
      const firstLuck = cards.indexOf(BETTER_LUCK);
      assert.notEqual(cards[0], BETTER_LUCK, `${amount}: ${cards}`);
      if (firstLuck >= 0) assert.ok(cards.slice(firstLuck).every((c) => c === BETTER_LUCK), `${amount}: ${cards}`);
    }
  }
});

test('arm is deterministic', () => {
  assert.equal(arm(168768, 10), arm(168768, 10));
});

// ─── Parity with the Python reference (test/fixtures/reward-parity.json) ─────

const parity = JSON.parse(read('./fixtures/reward-parity.json'));
// snake_case -> camelCase (recharges_30d -> recharges30d)
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const fromPython = (features) => Object.fromEntries(Object.entries(features).map(([k, v]) => [camel(k), v]));

test('parity: section scores match the reference for 500 users', () => {
  for (const u of parity.users) assert.deepEqual(scoreUser(fromPython(u.features)), u.score, JSON.stringify(u.features));
});

test('parity: population params and coins match the reference', () => {
  const p = populationParams(parity.users.map((u) => u.score.total));
  assert.equal(p.medianScore, parity.population.median_score);
  assert.ok(Math.abs(p.coinsPerShare - parity.population.coins_per_share) < 1e-9);
  assert.equal(p.budgetCoins, parity.population.budget_coins);
  for (const u of parity.users) assert.equal(totalCoins(u.score.total, p), u.total_coins);
});

test('parity: decks and prizes match the reference for every total', () => {
  for (const [total, expected] of Object.entries(parity.decks)) {
    const days = buildDeck(Number(total));
    assert.deepEqual(days, expected.days, `total ${total}`);
    assert.deepEqual(days.map((d) => prizesForDay(d)), expected.prizes, `total ${total}`);
  }
});

test('parity: arms match the reference', () => {
  for (const [userId, expected] of Object.entries(parity.arms)) assert.equal(arm(Number(userId), 10), expected, userId); // reference uses a 10% holdout
});

// ─── Factor levels at each boundary (SPEC §3) ────────────────────────────────

test('money: AOV boundaries', () => {
  const aov = (r) => moneyPoints(f({ medianRechargeRs: r })) - moneyPoints(base);
  assert.deepEqual([49.99, 50, 149.99, 150, 499.99, 500].map(aov), [0, 2, 2, 6, 6, 10]); // 3·5·9·13
});

test('money: frequency boundaries', () => {
  const freq = (n) => moneyPoints(f({ recharges30d: n })) - moneyPoints(base);
  assert.deepEqual([2, 3, 4, 5, 9, 10].map(freq), [0, 3, 3, 5, 5, 7]); // 4·7·9·11
});

test('money: due-for-recharge boundaries, gap floored at 0.5 day', () => {
  const due = (days, gap) => moneyPoints(f({ daysSinceLastRecharge: days, usualGapDays: gap })) - moneyPoints(base);
  assert.deepEqual([0.49, 0.5, 1.5, 1.51, 3, 3.01].map((d) => due(d, 1)), [3, 8, 8, 4, 4, 0]);
  assert.equal(due(0.2, 0.1), 3); // 0.2 / max(0.1, 0.5) = 0.4
});

test('money: pack trend and missing previous pack', () => {
  const trend = (last, prev) => moneyPoints(f({ lastPackCoins: last, prevPackCoins: prev })) - moneyPoints(base);
  assert.deepEqual([trend(300, 80), trend(300, 300), trend(80, 300), trend(300, null), trend(null, null)], [4, 3, 0, 0, 0]);
});

test('money: offer use boundaries', () => {
  const offer = (s) => moneyPoints(f({ offerShare: s })) - moneyPoints(base);
  assert.deepEqual([0, 0.2499, 0.25, 0.75, 0.7501].map(offer), [4, 4, 3, 3, 0]);
});

test('money: maximum is 40', () => {
  assert.equal(moneyPoints(f({
    medianRechargeRs: 500, recharges30d: 10, daysSinceLastRecharge: 1, usualGapDays: 1,
    lastPackCoins: 450, prevPackCoins: 300, offerShare: 0
  })), 40);
});

test('calls: minutes, trend, video, repeat boundaries', () => {
  const mins = (m) => callsPoints(f({ minutesThisWeek: m, minutesLastWeek: m }));
  // minutes level + trend 5 (same as last week)
  assert.deepEqual([14.9, 15, 59.9, 60, 179.9, 180].map(mins), [9, 13, 13, 16, 16, 19]);
  const trend = (m, last) => callsPoints(f({ minutesThisWeek: m, minutesLastWeek: last })) - callsPoints(f({ minutesThisWeek: m, minutesLastWeek: 1e9 }));
  assert.equal(callsPoints(f({ minutesThisWeek: 0, minutesLastWeek: 0 })), 0); // no calls either week
  assert.deepEqual([trend(10, 0), trend(12, 10), trend(11.9, 10), trend(8, 10), trend(7.9, 10)], [7, 7, 4, 4, 0]); // 8·8·5·5·1
  const video = (v) => callsPoints(f({ minutesThisWeek: 100, minutesLastWeek: 100, videoMinutesThisWeek: v })) - 16;
  assert.deepEqual([0, 24.9, 25, 49.9, 50, 100].map(video), [0, 3, 6, 6, 7, 7]);
  const rep = (n) => callsPoints(f({ maxCallsSameListener: n }));
  assert.deepEqual([0, 1, 2, 3].map(rep), [0, 0, 3, 6]);
});

test('calls: no calls at all scores 0; maximum is 35', () => {
  assert.equal(callsPoints(base), 0);
  assert.equal(callsPoints(f({ minutesThisWeek: 180, minutesLastWeek: 0, videoMinutesThisWeek: 90, maxCallsSameListener: 3 })), 35);
});

test('shopping, wallet and profile levels', () => {
  assert.deepEqual([0, 1, 2, 9].map((a) => shoppingPoints(f({ unfinishedPaymentAttempts: a }))), [0, 9, 15, 15]);
  assert.deepEqual([0, 1, 2].map((n) => walletPoints(f({ ranOutCalls: n }))), [0, 0, 5]);
  assert.equal(profilePoints(f({ isIos: true })), 2);
  assert.equal(profilePoints(f({ isInternational: true })), 2);
  assert.deepEqual([89, 90].map((d) => profilePoints(f({ accountAgeDays: d }))), [0, 1]);
});

test('total is the sum of sections', () => {
  const s = scoreUser(f({ minutesThisWeek: 30, unfinishedPaymentAttempts: 1, isIos: true }));
  assert.equal(s.total, s.money + s.calls + s.shopping + s.wallet + s.profile);
});

// ─── Helpers, deck examples, arm split, cap, config ──────────────────────────

test('median and round-half-even match Python', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual([0.5, 1.5, 2.5, 2.4, 2.6, 21.5].map(roundHalfEven), [0, 2, 2, 2, 3, 22]);
});

test('spec deck examples', () => {
  assert.deepEqual(buildDeck(10), [0, 0, 0, 0, 10]);
  assert.deepEqual(buildDeck(80), [0, 10, 15, 20, 35]);
  assert.deepEqual(buildDeck(130), [10, 15, 25, 30, 50]);
  assert.deepEqual(buildDeck(205), [20, 30, 40, 50, 65]);
});

test('makeable set is exactly the spec list', () => {
  const expected = [0, ...Array.from({ length: 17 }, (_, i) => 10 + 5 * i), 100, 110, 115, 120, 150];
  assert.deepEqual([...REPRESENTABLE].sort((a, b) => a - b), expected);
});

test('legacy and standard decks: makeable days, 90 coins each', () => {
  for (const deck of [CFG.legacy_deck, CFG.standard_deck]) {
    assert.equal(deck.length, CFG.plan_days);
    assert.ok(deck.every((d) => REPRESENTABLE.has(d)), String(deck));
    assert.equal(deck.reduce((a, b) => a + b, 0), 90);
  }
  assert.deepEqual(CFG.standard_deck, [15, 15, 10, 25, 25]);
});

test('arm split follows holdout_pct; default has no holdout', () => {
  let holdout = 0;
  for (let id = 1; id <= 20000; id += 1) if (arm(id, 10) === ARMS.holdout) holdout += 1;
  assert.ok(Math.abs(holdout / 20000 - 0.10) < 0.01, `holdout ${holdout}`);
  assert.equal(arm(5, 0), ARMS.treatment);
  assert.equal(arm(5, 100), ARMS.holdout);
  assert.equal(CFG.holdout_pct, 0);
  for (let id = 1; id <= 1000; id += 1) assert.equal(arm(id), ARMS.treatment);
});

test('daily cap: untouched below the cap, scaled down above it', () => {
  assert.deepEqual(applyDailyCap([100, 200], null), { totals: [100, 200], scale: 1, capped: false });
  assert.deepEqual(applyDailyCap([100, 200], 300), { totals: [100, 200], scale: 1, capped: false });
  const r = applyDailyCap([100, 200], 150);
  assert.equal(r.capped, true);
  assert.deepEqual(r.totals, [50, 100]);
  assert.deepEqual(applyDailyCap([20, 20], 10).totals, [10, 10]); // min_coins still holds
});

test('daily cap: a tiny overage trims the largest plans, not everyone', () => {
  const totals = [130, 130, 130, 15, 15, 15, 120, 125];
  const cap = totals.reduce((a, b) => a + b, 0) - 5;
  const r = applyDailyCap(totals, cap);
  assert.ok(r.totals.reduce((a, b) => a + b, 0) <= cap);
  assert.equal(totals.filter((t, i) => r.totals[i] !== t).length, 1);
  assert.equal(r.totals[0], 125);
  for (let n = 0; n < 50; n += 1) {
    const many = Array.from({ length: 200 }, (_, i) => [15, 60, 95, 130, 140][(i * 7 + n) % 5]);
    const c = Math.floor(many.reduce((a, b) => a + b, 0) * 0.97);
    const out = applyDailyCap(many, c).totals;
    assert.ok(out.reduce((a, b) => a + b, 0) <= c);
    assert.ok(out.every((t) => t >= 10 && t % 5 === 0));
  }
});

test('config overrides and rejects unknown keys', () => {
  assert.equal(loadRewardConfig({}).high_floor, 0.1);
  assert.equal(loadRewardConfig({ REWARD_CONFIG_JSON: '{"high_floor":0.15}' }).high_floor, 0.15);
  assert.throws(() => loadRewardConfig({ REWARD_CONFIG_JSON: '{"hi_floor":0.15}' }), /unknown keys/);
});
