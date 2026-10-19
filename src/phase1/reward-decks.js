import { randomInt } from 'crypto';

// Pure deck logic (no DB) so it can be tested on its own.
//
// A template lists the winning cards for each day of a cycle; every day is
// padded with 0-coin "better luck" cards up to SPINS_PER_DAY and shuffled once
// when the cycle is created. The cap is simply the sum of the template, so a
// cycle can never pay more than its template.

export const SPINS_PER_DAY = 3;

export const DECK_TEMPLATES = {
  // Unpaid trial: 10 · 15 · 10 · 20 · 35
  unpaid_trial: [[10], [15], [10], [20], [20, 15]],
  // Paid, same for every qualifying recharge: 10 · 15 · 10 · 20 · 65
  paid_flat: [[10], [15], [10], [20], [50, 15]],
  // Paid, proportional to the recharge (see tierForRecharge)
  tier_t1: [[10], [15], [10], [20], [50, 15]],
  tier_t2: [[15], [20], [15], [10, 20], [50, 50]],
  tier_t3: [[20], [15, 15], [20], [15, 15, 20], [50, 50, 20]],
  tier_t4: [[20], [15, 20], [10, 15], [20, 50], [50, 50, 50]],
  tier_vip: [[20], [15, 20], [10, 15], [20, 50], [500, 50]]
};

// Lower bound of each tier in rupees, highest first. Mapped to the Dostt
// wallet packs: ₹149/₹251 → T1, ₹550–₹1055 → T2, ₹1999/₹2651 → T3,
// ₹5000 → T4, ₹9999+ → VIP. Anything below ₹149 (the ₹62 pack) earns nothing.
const TIER_THRESHOLDS = [
  [9999, 'tier_vip'],
  [5000, 'tier_t4'],
  [1999, 'tier_t3'],
  [550, 'tier_t2'],
  [149, 'tier_t1']
];

export function tierForRecharge(amountRupees) {
  const match = TIER_THRESHOLDS.find(([min]) => Number(amountRupees) >= min);
  return match ? match[1] : null;
}

export function templateCap(templateName) {
  const template = DECK_TEMPLATES[templateName];
  if (!template) throw new Error(`Unknown deck template: ${templateName}`);
  return template.flat().reduce((sum, coins) => sum + coins, 0);
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Moves the biggest winning card of a day to the front; the rest keep their order.
export function winFirst(dayCoins) {
  const best = dayCoins.indexOf(Math.max(...dayCoins));
  return [dayCoins[best], ...dayCoins.filter((_, index) => index !== best)];
}

/**
 * Builds the cards of one cycle as [{ day, position, coins }].
 * Cards are drawn in (day, position) order, so missed spins carry over.
 * firstSpinWins makes day 1's first spin a win (for a player's first cycle).
 */
export function buildDeck(templateName, { firstSpinWins = false, random = randomInt } = {}) {
  const template = DECK_TEMPLATES[templateName];
  if (!template) throw new Error(`Unknown deck template: ${templateName}`);

  const cards = [];
  template.forEach((wins, dayIndex) => {
    const day = dayIndex + 1;
    const padded = [...wins, ...Array(SPINS_PER_DAY - wins.length).fill(0)];
    let ordered = shuffle(padded, random);
    if (firstSpinWins && day === 1) {
      ordered = winFirst(ordered);
    }
    ordered.forEach((coins, index) => cards.push({ day, position: index + 1, coins }));
  });
  return cards;
}

export function validateTemplate(templateName) {
  const template = DECK_TEMPLATES[templateName];
  const problems = [];
  template.forEach((wins, index) => {
    if (wins.length === 0) problems.push(`day ${index + 1} has no win`);
    if (wins.length > SPINS_PER_DAY) problems.push(`day ${index + 1} has more wins than spins`);
    if (wins.some((coins) => coins <= 0)) problems.push(`day ${index + 1} has a non-positive win`);
  });
  const lastDayTotal = template.at(-1).reduce((sum, coins) => sum + coins, 0);
  const otherTotals = template.slice(0, -1).map((wins) => wins.reduce((sum, coins) => sum + coins, 0));
  if (otherTotals.some((total) => total >= lastDayTotal)) problems.push('last day is not the biggest day');
  return problems;
}
