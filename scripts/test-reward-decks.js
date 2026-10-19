import assert from 'node:assert/strict';
import { DECK_TEMPLATES, SPINS_PER_DAY, buildDeck, templateCap, tierForRecharge, validateTemplate, winFirst } from '../src/phase1/reward-decks.js';

// Pure checks on deck templates and generation; no database needed.

const expectedCaps = {
  unpaid_trial: 90,
  paid_flat: 120,
  tier_t1: 120,
  tier_t2: 180,
  tier_t3: 240,
  tier_t4: 300,
  tier_vip: 700
};

for (const [name, cap] of Object.entries(expectedCaps)) {
  assert.equal(templateCap(name), cap, `${name} cap`);
  assert.deepEqual(validateTemplate(name), [], `${name} template rules`);
}
assert.deepEqual(Object.keys(DECK_TEMPLATES).sort(), Object.keys(expectedCaps).sort(), 'every template has an expected cap');

// Generated decks: right size, right total, every day keeps its own cards.
for (const name of Object.keys(DECK_TEMPLATES)) {
  for (let run = 0; run < 200; run += 1) {
    const cards = buildDeck(name);
    assert.equal(cards.length, DECK_TEMPLATES[name].length * SPINS_PER_DAY, `${name} card count`);
    assert.equal(cards.reduce((sum, c) => sum + c.coins, 0), expectedCaps[name], `${name} total`);
    DECK_TEMPLATES[name].forEach((wins, index) => {
      const dayCoins = cards.filter((c) => c.day === index + 1).map((c) => c.coins).sort((a, b) => a - b);
      const expected = [...wins, ...Array(SPINS_PER_DAY - wins.length).fill(0)].sort((a, b) => a - b);
      assert.deepEqual(dayCoins, expected, `${name} day ${index + 1} cards`);
    });
  }
}

// Shuffle actually varies the winning position on a one-win day.
const positions = new Set();
for (let run = 0; run < 300; run += 1) {
  positions.add(buildDeck('unpaid_trial').find((c) => c.day === 2 && c.coins > 0).position);
}
assert.deepEqual([...positions].sort(), [1, 2, 3], 'day-2 win lands on every spin position');

// firstSpinWins puts a win on day 1 spin 1.
for (let run = 0; run < 100; run += 1) {
  const first = buildDeck('unpaid_trial', { firstSpinWins: true });
  assert.ok(first.find((c) => c.day === 1 && c.position === 1).coins > 0, 'first spin wins');
}

assert.deepEqual(winFirst([0, 15, 0]), [15, 0, 0]);
assert.deepEqual(winFirst([0, 50, 15]), [50, 0, 15]);

// Tier mapping against the Dostt wallet packs.
const packs = [[62, null], [149, 'tier_t1'], [251, 'tier_t1'], [550, 'tier_t2'], [1049, 'tier_t2'],
  [1055, 'tier_t2'], [1999, 'tier_t3'], [2651, 'tier_t3'], [5000, 'tier_t4'], [9999, 'tier_vip'],
  [17999, 'tier_vip'], [28999, 'tier_vip']];
for (const [price, tier] of packs) {
  assert.equal(tierForRecharge(price), tier, `₹${price} → ${tier}`);
}

console.log('Reward deck tests passed ✓');
