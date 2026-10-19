import { createHash } from 'crypto';
import { DEFAULT_REWARD_CONFIG } from './reward-config.js';

// Pure reward logic for regular payers (no I/O), ported from
// docs/spin_reward_handoff/reference_python/reward_logic_reference.py.
// Behaviour must stay identical to the reference.
//
// features (per user) -> section points -> total score
// whole scored population -> median score + coins per share
// users whose plan ended -> share -> total coins -> 5-day deck -> daily cards

export const ENGINE_VERSION = 'spin_reward_v1';
// Salt of the arm hash. Never change it: that would move users between arms.
const ARM_SALT = 'spin_reward_v1';
export const BETTER_LUCK = 'BETTER_LUCK';
export const ARMS = { holdout: 'holdout_legacy_90', treatment: 'median_low_favoured' };

// ─── Points (Money 40, Calls 35, Shopping 15, Wallet 5, Profile 5) ───────────
//
// Features use IST windows as of end of scoring date S:
//   recharges30d, medianRechargeRs, daysSinceLastRecharge, usualGapDays,
//   lastPackCoins, prevPackCoins (null when unknown), offerShare,
//   minutesThisWeek, minutesLastWeek, videoMinutesThisWeek, maxCallsSameListener,
//   unfinishedPaymentAttempts, ranOutCalls, isIos, isInternational, accountAgeDays

export function moneyPoints(f) {
  const r = f.medianRechargeRs;
  const aov = r < 50 ? 3 : r < 150 ? 5 : r < 500 ? 9 : 13;
  const n = f.recharges30d;
  const freq = n >= 10 ? 11 : n >= 5 ? 9 : n >= 3 ? 7 : 4;
  const ratio = f.daysSinceLastRecharge / Math.max(f.usualGapDays, 0.5);
  const due = ratio < 0.5 ? 3 : ratio <= 1.5 ? 8 : ratio <= 3 ? 4 : 0;
  let trend = 0;
  if (f.lastPackCoins != null && f.prevPackCoins != null) {
    trend = f.lastPackCoins > f.prevPackCoins ? 4 : f.lastPackCoins === f.prevPackCoins ? 3 : 0;
  }
  const offer = f.offerShare < 0.25 ? 4 : f.offerShare <= 0.75 ? 3 : 0;
  return aov + freq + due + trend + offer;
}

export function callsPoints(f) {
  const m = f.minutesThisWeek;
  const last = f.minutesLastWeek;
  const minutes = m === 0 ? 0 : m < 15 ? 4 : m < 60 ? 8 : m < 180 ? 11 : 14;
  let trend;
  if (m === 0 && last === 0) trend = 0;
  else if (last === 0) trend = 8;
  else if (m >= 1.2 * last) trend = 8;
  else if (m >= 0.8 * last) trend = 5;
  else trend = 1;
  const v = f.videoMinutesThisWeek;
  const video = v === 0 ? 0 : v < 0.25 * m ? 3 : v < 0.5 * m ? 6 : 7;
  const calls = f.maxCallsSameListener;
  const repeat = calls >= 3 ? 6 : calls === 2 ? 3 : 0;
  return minutes + trend + video + repeat;
}

export function shoppingPoints(f) {
  const a = f.unfinishedPaymentAttempts;
  return a >= 2 ? 15 : a === 1 ? 9 : 0;
}

export function walletPoints(f) {
  return f.ranOutCalls >= 2 ? 5 : 0;
}

export function profilePoints(f) {
  return (f.isIos ? 2 : 0) + (f.isInternational ? 2 : 0) + (f.accountAgeDays >= 90 ? 1 : 0);
}

export function scoreUser(f) {
  const s = {
    money: moneyPoints(f),
    calls: callsPoints(f),
    shopping: shoppingPoints(f),
    wallet: walletPoints(f),
    profile: profilePoints(f)
  };
  s.total = s.money + s.calls + s.shopping + s.wallet + s.profile;
  return s;
}

// ─── Share: median gets 1.0; lower side falls slowly, higher side fast ───────

export function share(score, medianScore, cfg = DEFAULT_REWARD_CONFIG) {
  if (score <= medianScore) {
    return Math.max(1 - (medianScore - score) / cfg.low_range, cfg.low_floor);
  }
  return Math.max(1 - (score - medianScore) / cfg.high_range, cfg.high_floor);
}

// Python's statistics.median: mean of the two middle values for even n.
export function median(values) {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Python's round(): ties go to the even integer.
export function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// Budget normalisation over the WHOLE scored population (not only tonight's
// new plans), so the average reward stays at budget_coins_per_user.
export function populationParams(scores, cfg = DEFAULT_REWARD_CONFIG) {
  const medianScore = median(scores);
  const totalShares = scores.reduce((sum, s) => sum + share(s, medianScore, cfg), 0);
  const budgetCoins = cfg.budget_coins_per_user * scores.length;
  return { medianScore, coinsPerShare: budgetCoins / totalShares, budgetCoins };
}

export function totalCoins(score, params, cfg = DEFAULT_REWARD_CONFIG) {
  const raw = share(score, params.medianScore, cfg) * params.coinsPerShare;
  const rounded = roundHalfEven(raw / cfg.round_to) * cfg.round_to;
  return Math.min(cfg.max_coins, Math.max(cfg.min_coins, rounded));
}

// ─── 5-day deck: back-loaded, every day makeable with ≤ 3 prizes ─────────────

function* combinationsWithReplacement(items, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  for (let i = start; i < items.length; i += 1) {
    yield* combinationsWithReplacement(items, k, i, [...prefix, items[i]]);
  }
}

const sum = (values) => values.reduce((total, v) => total + v, 0);

// {0, 10, 15, …, 120, 150}; e.g. 95, 105, 125–145 are NOT makeable.
export function representableAmounts(cfg = DEFAULT_REWARD_CONFIG) {
  const amounts = new Set([0]);
  for (let k = 1; k <= cfg.max_wins_per_day; k += 1) {
    for (const combo of combinationsWithReplacement(cfg.prizes, k)) amounts.add(sum(combo));
  }
  return amounts;
}

/**
 * Splits total coins into plan_days daily amounts; each day is 0 or makeable
 * with ≤ max_wins_per_day prizes. The total is kept except, in rare edge
 * cases, up to round_to coins.
 */
export function buildDeck(total, cfg = DEFAULT_REWARD_CONFIG) {
  const representable = representableAmounts(cfg);
  const maxDay = Math.max(...representable);
  const largestRepAtMost = (x) => Math.max(...[...representable].filter((v) => v <= x));

  const days = cfg.deck_weights.map((w) => {
    const raw = total * w;
    return raw >= cfg.min_coins ? Math.floor(raw / cfg.round_to) * cfg.round_to : 0;
  });
  days.push(total - sum(days));

  // From the last day backwards: push anything not makeable (or above the max day) to the previous day.
  for (let i = days.length - 1; i > 0; i -= 1) {
    const keep = largestRepAtMost(Math.min(days[i], maxDay));
    days[i - 1] += days[i] - keep;
    days[i] = keep;
  }
  // Day 1: whatever is not makeable goes to the latest day that can absorb it.
  const keep = largestRepAtMost(Math.min(days[0], maxDay));
  let extra = days[0] - keep;
  days[0] = keep;
  for (let i = days.length - 1; i >= 0 && extra !== 0; i -= 1) {
    if (representable.has(days[i] + extra)) {
      days[i] += extra;
      extra = 0;
    }
  }
  return days; // any remaining extra (≤ round_to coins, very rare) is dropped
}

// Fewest prizes (≤ max_wins_per_day) summing to amount, larger prizes first.
export function prizesForDay(amount, cfg = DEFAULT_REWARD_CONFIG) {
  if (amount === 0) return [];
  const descending = [...cfg.prizes].sort((a, b) => b - a);
  for (let k = 1; k <= cfg.max_wins_per_day; k += 1) {
    for (const combo of combinationsWithReplacement(descending, k)) {
      if (sum(combo) === amount) return combo;
    }
  }
  throw new Error(`amount ${amount} not makeable`);
}

function seededRandom(seedText) {
  // mulberry32 seeded from the first 4 bytes of sha256(seedText).
  let a = createHash('sha256').update(seedText).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One day's cards: the day's wins first, then BETTER_LUCK, so a player who
 * spins once that day still gets the win (product decision 2026-10-19; the
 * spec's full shuffle could hide the win behind an unspun card). The order of
 * the wins among themselves is shuffled with a deterministic seed. The caller
 * stores the cards, so a reload never re-rolls.
 */
export function dayCards(amount, planId, day, cfg = DEFAULT_REWARD_CONFIG) {
  const wins = [...prizesForDay(amount, cfg)];
  const random = seededRandom(`${planId}:${day}`);
  for (let i = wins.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [wins[i], wins[j]] = [wins[j], wins[i]];
  }
  return [...wins, ...Array(cfg.max_wins_per_day - wins.length).fill(BETTER_LUCK)];
}

// Deck as daily amounts -> daily cards. A legacy deck day of 10/50 is a single prize.
export function planCards(deck, planId, cfg = DEFAULT_REWARD_CONFIG) {
  return deck.map((amount, index) => dayCards(amount, planId, index + 1, cfg));
}

// ─── Experiment arm: deterministic, identical to the reference ───────────────

export function arm(userId, holdoutPct = DEFAULT_REWARD_CONFIG.holdout_pct) {
  const hex = createHash('sha256').update(`${ARM_SALT}:${userId}`).digest('hex');
  const bucket = Number(BigInt(`0x${hex}`) % 100n);
  return bucket < holdoutPct ? ARMS.holdout : ARMS.treatment;
}

// ─── Daily cap: scale tonight's new plans down proportionally ────────────────

export function applyDailyCap(totals, capCoins, cfg = DEFAULT_REWARD_CONFIG) {
  const planned = sum(totals);
  if (capCoins == null || planned <= capCoins) {
    return { totals, scale: 1, capped: false };
  }
  const scale = capCoins / planned;
  // Scale and round to round_to (min_coins still applies per user), then take
  // round_to coins at a time from the largest plans until the cap holds. A
  // tiny overage then costs a few users 5 coins instead of everyone.
  const scaled = totals.map((t) =>
    Math.max(cfg.min_coins, roundHalfEven((t * scale) / cfg.round_to) * cfg.round_to)
  );
  let excess = sum(scaled) - capCoins;
  const byLargest = scaled.map((t, i) => i).sort((a, b) => scaled[b] - scaled[a] || a - b);
  for (let pass = 0; excess > 0; pass += 1) {
    let trimmed = false;
    for (const i of byLargest) {
      if (excess <= 0) break;
      if (scaled[i] - cfg.round_to < cfg.min_coins) continue;
      scaled[i] -= cfg.round_to;
      excess -= cfg.round_to;
      trimmed = true;
    }
    if (!trimmed) break; // everyone at min_coins: the cap can't be met
  }
  return { totals: scaled, scale, capped: true };
}
