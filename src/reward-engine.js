import { runQuery } from './db.js';
import { loadRewardConfig } from './reward-config.js';
import { ENGINE_VERSION, planCards, BETTER_LUCK } from './reward-logic.js';
import { deckForUnscored, isPlanFinished, noPlanAction, planDayForSpin, SEGMENTS } from './reward-planner.js';

// Personalised reward engine v1 (docs/spin_reward_handoff/SPEC.md).
//
// REWARD_ENGINE=off      legacy daily rule; no plans are made or read
// REWARD_ENGINE=dry_run  everything runs on "shadow" plans (nightly scoring,
//                        draws on every spin) but players get the legacy rule
// REWARD_ENGINE=on       spins draw from the player's live plan
//
// A plan covers 5 SPIN days: day 1 is the first day the player spins on it,
// day 2 the next day they spin, and so on, whatever the calendar gap. Each
// spin day has 3 stored cards, wins first (so the first spin of the day wins);
// cards not spun that day are lost.
// Regular payers get a scored plan from the nightly job; one-time payers get
// 15·15·10·25·25 plans; unpaid users get one 15·15·10·25·25 trial and then
// Better Luck until they recharge. A plan's rewards never change.

export const ENGINE_MODES = ['off', 'dry_run', 'on'];

export function getRewardEngineMode(env = process.env) {
  return ENGINE_MODES.includes(env.REWARD_ENGINE) ? env.REWARD_ENGINE : 'off';
}

export function isRewardEngineServing(env = process.env) {
  return getRewardEngineMode(env) === 'on';
}

export const PLAN_MODE_FOR = { on: 'live', dry_run: 'shadow' };

const toCoins = (card) => (card === BETTER_LUCK ? 0 : card);

/**
 * Stores plans and their pre-shuffled cards, inside the caller's transaction.
 * plans: [{ playerId, segment, arm, features, scores, medianScore, share,
 *           coinsPerShare, scoredCoins, totalCoins, deck, engineVersion }]
 * A player who still has an open plan of this mode is skipped, so a running
 * plan is never replaced. Returns the number of plans stored.
 */
export async function insertPlans(client, plans, { runId = null, mode, startDate, cfg = loadRewardConfig() }) {
  if (plans.length === 0) return 0;
  const { rows } = await client.query(
    `
      INSERT INTO reward_plans (player_id, run_id, mode, segment, arm, features, scores, median_score, share,
                                coins_per_share, scored_coins, total_coins, deck, engine_version, start_date)
      SELECT x.player_id, $2::bigint, $3::text, x.segment, x.arm, x.features, x.scores, x.median_score, x.share,
             x.coins_per_share, x.scored_coins, x.total_coins,
             ARRAY(SELECT jsonb_array_elements_text(x.deck)::int),
             x.engine_version, $4::date
      FROM jsonb_to_recordset($1::jsonb) AS x(
        player_id bigint, segment text, arm text, features jsonb, scores jsonb, median_score numeric,
        share numeric, coins_per_share numeric, scored_coins int, total_coins int, deck jsonb, engine_version text
      )
      ON CONFLICT (player_id, mode) WHERE ended_at IS NULL DO NOTHING
      RETURNING id, player_id, deck
    `,
    [
      JSON.stringify(plans.map((p) => ({
        player_id: p.playerId,
        segment: p.segment,
        arm: p.arm ?? null,
        features: p.features ?? null,
        scores: p.scores ?? null,
        median_score: p.medianScore ?? null,
        share: p.share ?? null,
        coins_per_share: p.coinsPerShare ?? null,
        scored_coins: p.scoredCoins ?? null,
        total_coins: p.totalCoins,
        deck: p.deck,
        engine_version: p.engineVersion
      }))),
      runId,
      mode,
      startDate
    ]
  );

  const planIds = [];
  const days = [];
  const positions = [];
  const coins = [];
  for (const plan of rows) {
    planCards(plan.deck, String(plan.id), cfg).forEach((dayCards, dayIndex) => {
      dayCards.forEach((card, index) => {
        planIds.push(plan.id);
        days.push(dayIndex + 1);
        positions.push(index + 1);
        coins.push(toCoins(card));
      });
    });
  }
  await client.query(
    `
      INSERT INTO reward_plan_cards (plan_id, day, position, coins)
      SELECT * FROM unnest($1::bigint[], $2::int[], $3::int[], $4::int[])
    `,
    [planIds, days, positions, coins]
  );
  return rows.length;
}

// Closes every open plan whose last spin day is over (nightly, before planning).
export async function endFinishedPlans(client, mode, today, cfg = loadRewardConfig()) {
  const { rowCount } = await client.query(
    `
      UPDATE reward_plans SET ended_at = NOW()
      WHERE mode = $1 AND ended_at IS NULL AND spin_days >= $2 AND last_spin_date < $3::date
    `,
    [mode, cfg.plan_days, today]
  );
  return rowCount;
}

async function findOpenPlan(client, playerId, mode) {
  const { rows } = await client.query(
    `
      SELECT id, spin_days, last_spin_date::text AS last_spin_date
      FROM reward_plans
      WHERE player_id = $1 AND mode = $2 AND ended_at IS NULL
      FOR UPDATE
    `,
    [playerId, mode]
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, spinDays: rows[0].spin_days, lastSpinDate: rows[0].last_spin_date };
}

/**
 * Draws the next card for a spin, inside the caller's transaction.
 * mode 'live' (REWARD_ENGINE=on) or 'shadow' (dry_run). Returns
 * { coins, planId }; coins 0 is Better Luck (no card left today, or no plan).
 */
export async function drawPlanCard(client, playerId, dateKey, { mode = 'live', cfg = loadRewardConfig() } = {}) {
  // Serialise draws for this player: two quick taps must not draw the same
  // card or both create a plan.
  const { rows: players } = await client.query(
    'SELECT reward_segment FROM players WHERE id = $1 FOR UPDATE',
    [playerId]
  );

  let plan = await findOpenPlan(client, playerId, mode);
  if (plan && isPlanFinished(plan, dateKey, cfg)) {
    await client.query('UPDATE reward_plans SET ended_at = NOW() WHERE id = $1', [plan.id]);
    plan = null;
  }

  if (!plan) {
    const { rows: previous } = await client.query(
      'SELECT 1 FROM reward_plans WHERE player_id = $1 AND mode = $2 LIMIT 1',
      [playerId, mode]
    );
    const action = noPlanAction({ segment: players[0]?.reward_segment, hadPlanBefore: previous.length > 0 });
    if (action !== 'legacy') return { coins: 0, planId: null };
    const segment = players[0]?.reward_segment || SEGMENTS.unpaid; // not seen by a nightly run yet = unpaid
    const deck = deckForUnscored(segment, cfg);
    await insertPlans(client, [{
      playerId,
      segment,
      totalCoins: deck.reduce((a, b) => a + b, 0),
      deck,
      engineVersion: ENGINE_VERSION
    }], { mode, startDate: dateKey, cfg });
    plan = await findOpenPlan(client, playerId, mode);
    if (!plan) return { coins: 0, planId: null };
  }

  const day = planDayForSpin(plan, dateKey);
  if (day !== plan.spinDays) {
    await client.query(
      'UPDATE reward_plans SET spin_days = $2, last_spin_date = $3::date WHERE id = $1',
      [plan.id, day, dateKey]
    );
  }

  const { rows } = await client.query(
    `
      UPDATE reward_plan_cards
      SET drawn_at = NOW()
      WHERE id = (
        SELECT id FROM reward_plan_cards
        WHERE plan_id = $1 AND day = $2 AND drawn_at IS NULL
        ORDER BY position
        LIMIT 1
      )
      RETURNING coins
    `,
    [plan.id, day]
  );
  return { coins: rows[0]?.coins ?? 0, planId: plan.id };
}

export async function resetPlayerPlans(client, playerId) {
  await client.query('DELETE FROM reward_plans WHERE player_id = $1', [playerId]);
  await client.query('UPDATE players SET reward_segment = NULL WHERE id = $1', [playerId]);
}

// ─── Admin report ────────────────────────────────────────────────────────────

export async function getRewardEngineReport() {
  const mode = getRewardEngineMode();
  const { rows: runs } = await runQuery(`
    SELECT id, scoring_date::text, plan_start_date::text, mode, status, population_size, median_score,
           coins_per_share, budget_coins, new_plans, planned_coins, summary, error, started_at, finished_at
    FROM reward_runs
    ORDER BY started_at DESC
    LIMIT 14
  `);
  // Planned vs drawn per run (NULL run = legacy plans given at spin time). For
  // shadow plans "drawn" is what players would have won under the engine.
  const { rows: redemption } = await runQuery(`
    SELECT rp.run_id, rp.mode, rp.segment, COALESCE(rp.arm, '—') AS arm,
           COUNT(*)::int AS plans,
           SUM(rp.total_coins)::int AS planned_coins,
           COALESCE(SUM(c.drawn), 0)::int AS redeemed_coins
    FROM reward_plans rp
    LEFT JOIN (
      SELECT plan_id, SUM(coins) AS drawn FROM reward_plan_cards WHERE drawn_at IS NOT NULL GROUP BY plan_id
    ) c ON c.plan_id = rp.id
    WHERE rp.created_at >= NOW() - interval '30 days'
    GROUP BY 1, 2, 3, 4
    ORDER BY rp.run_id DESC NULLS LAST, 2, 3, 4
  `);
  const { rows: running } = await runQuery(`
    SELECT mode, segment, COALESCE(arm, '—') AS arm, COUNT(*)::int AS plans
    FROM reward_plans
    WHERE ended_at IS NULL
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `);
  return { mode, engineVersion: ENGINE_VERSION, config: loadRewardConfig(), runs, redemption, running };
}

// Score breakdown, share, coins, deck and cards of a player's recent plans.
export async function getPlayerRewardPlans({ dosttUserId = null, mobileNumber = null }) {
  const { rows: plans } = await runQuery(
    `
      SELECT rp.id, rp.run_id, rp.mode, rp.segment, rp.arm, rp.scores, rp.features, rp.median_score, rp.share,
             rp.coins_per_share, rp.scored_coins, rp.total_coins, rp.deck, rp.engine_version,
             rp.start_date::text, rp.spin_days, rp.last_spin_date::text, rp.ended_at, rp.created_at, p.dostt_user_id, p.mobile_number, p.reward_segment
      FROM reward_plans rp
      JOIN players p ON p.id = rp.player_id
      WHERE ($1::int IS NOT NULL AND p.dostt_user_id = $1) OR ($2::text IS NOT NULL AND p.mobile_number = $2)
      ORDER BY rp.created_at DESC, rp.id DESC
      LIMIT 10
    `,
    [dosttUserId, mobileNumber]
  );
  if (plans.length === 0) return { plans: [] };
  const { rows: cards } = await runQuery(
    `
      SELECT plan_id, day, position, coins, drawn_at
      FROM reward_plan_cards
      WHERE plan_id = ANY($1::bigint[])
      ORDER BY plan_id, day, position
    `,
    [plans.map((p) => p.id)]
  );
  return {
    plans: plans.map((p) => ({ ...p, cards: cards.filter((c) => String(c.plan_id) === String(p.id)) }))
  };
}
