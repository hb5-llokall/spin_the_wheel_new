import dotenv from 'dotenv';
import { runInTransaction, runQuery } from '../db.js';
import { buildDeck, templateCap, tierForRecharge } from './reward-decks.js';

dotenv.config();

// The engine replaces the legacy "one hashed winning spin a day" rule when
// REWARD_ENGINE=on. Each player draws from their own pre-shuffled cycle of
// cards: an unpaid 90-coin trial on first spin, then a paid cycle per
// qualifying recharge. With no active cycle every spin is Better Luck.

export function isRewardEngineEnabled() {
  return process.env.REWARD_ENGINE === 'on';
}

function settings() {
  return {
    paidMode: process.env.REWARD_PAID_MODE === 'proportional' ? 'proportional' : 'flat',
    minRecharge: Number(process.env.REWARD_MIN_RECHARGE || 149),
    firstSpinWins: process.env.REWARD_FIRST_SPIN_WINS !== 'false',
    // A cycle has 15 cards; at one spin a day that takes 15 days, so expiry
    // must leave room for that or a once-a-day player loses the last card.
    expiryDays: Number(process.env.REWARD_CYCLE_EXPIRY_DAYS || 21),
    maxPaidCyclesPerMonth: Number(process.env.REWARD_MAX_PAID_CYCLES_PER_MONTH || 6)
  };
}

async function createCycle(client, playerId, { kind, template, status, rechargeEventId = null, firstSpinWins = false }) {
  const { expiryDays } = settings();
  const { rows } = await client.query(
    `
      INSERT INTO reward_cycles (player_id, kind, template, cap_coins, status, recharge_event_id, started_at, expires_at)
      VALUES ($1, $2, $3, $4, $5::text, $6,
              CASE WHEN $5::text = 'active' THEN NOW() END,
              CASE WHEN $5::text = 'active' THEN NOW() + make_interval(days => $7) END)
      RETURNING id
    `,
    [playerId, kind, template, templateCap(template), status, rechargeEventId, expiryDays]
  );
  const cycleId = rows[0].id;
  const cards = buildDeck(template, { firstSpinWins });
  await client.query(
    `
      INSERT INTO reward_cards (cycle_id, day, position, coins)
      SELECT $1::bigint, * FROM unnest($2::int[], $3::int[], $4::int[])
    `,
    [cycleId, cards.map((c) => c.day), cards.map((c) => c.position), cards.map((c) => c.coins)]
  );
  return cycleId;
}

async function endCycle(client, cycleId, status) {
  await client.query(
    'UPDATE reward_cycles SET status = $2, ended_at = NOW() WHERE id = $1',
    [cycleId, status]
  );
}

// Activates the oldest queued cycle, if any. Returns its id or null.
async function promoteQueued(client, playerId) {
  const { expiryDays } = settings();
  const { rows } = await client.query(
    `
      UPDATE reward_cycles
      SET status = 'active', started_at = NOW(), expires_at = NOW() + make_interval(days => $2)
      WHERE id = (
        SELECT id FROM reward_cycles
        WHERE player_id = $1 AND status = 'queued'
        ORDER BY created_at
        LIMIT 1
      )
      RETURNING id
    `,
    [playerId, expiryDays]
  );
  return rows[0]?.id || null;
}

async function lockActiveCycle(client, playerId) {
  const { rows } = await client.query(
    `
      SELECT id, kind, expires_at < NOW() AS expired
      FROM reward_cycles
      WHERE player_id = $1 AND status = 'active'
      FOR UPDATE
    `,
    [playerId]
  );
  return rows[0] || null;
}

/**
 * Draws the next card for a spin, inside the caller's transaction.
 * Returns { coins, cycleId }. coins is 0 (Better Luck) when no cycle is active.
 */
export async function drawNextCard(client, playerId) {
  // Serialise draws (and cycle creation) for this player: two quick taps must
  // not draw the same card or both create a trial.
  await client.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);

  let cycle = await lockActiveCycle(client, playerId);

  if (!cycle) {
    const { rows } = await client.query('SELECT 1 FROM reward_cycles WHERE player_id = $1 LIMIT 1', [playerId]);
    if (rows.length === 0) {
      // First spin under the engine: start the unpaid trial.
      await createCycle(client, playerId, {
        kind: 'unpaid_trial',
        template: 'unpaid_trial',
        status: 'active',
        firstSpinWins: settings().firstSpinWins
      });
    } else {
      await promoteQueued(client, playerId);
    }
    cycle = await lockActiveCycle(client, playerId);
  }

  if (cycle?.expired) {
    await endCycle(client, cycle.id, 'expired');
    await promoteQueued(client, playerId);
    cycle = await lockActiveCycle(client, playerId);
  }

  if (!cycle) return { coins: 0, cycleId: null };

  const { rows } = await client.query(
    `
      UPDATE reward_cards
      SET drawn_at = NOW()
      WHERE id = (
        SELECT id FROM reward_cards
        WHERE cycle_id = $1 AND drawn_at IS NULL
        ORDER BY day, position
        LIMIT 1
      )
      RETURNING coins
    `,
    [cycle.id]
  );
  const coins = rows[0]?.coins ?? 0;

  const { rows: remaining } = await client.query(
    'SELECT 1 FROM reward_cards WHERE cycle_id = $1 AND drawn_at IS NULL LIMIT 1',
    [cycle.id]
  );
  if (remaining.length === 0) {
    await endCycle(client, cycle.id, 'completed');
    await promoteQueued(client, playerId);
  }

  return { coins, cycleId: cycle.id };
}

function templateForRecharge(amountRupees) {
  const { paidMode, minRecharge } = settings();
  if (paidMode === 'proportional') return tierForRecharge(amountRupees);
  return Number(amountRupees) >= minRecharge ? 'paid_flat' : null;
}

async function startCycleForRecharge(client, playerId, rechargeEventId, amountRupees) {
  const template = templateForRecharge(amountRupees);
  if (!template) return { started: false, reason: 'below_minimum' };

  const { rows: recent } = await client.query(
    `
      SELECT COUNT(*)::int AS n FROM reward_cycles
      WHERE player_id = $1 AND kind = 'paid' AND created_at > NOW() - interval '30 days'
    `,
    [playerId]
  );
  if (recent[0].n >= settings().maxPaidCyclesPerMonth) return { started: false, reason: 'monthly_limit' };

  const active = await lockActiveCycle(client, playerId);
  if (active && active.kind === 'unpaid_trial') {
    await endCycle(client, active.id, 'superseded');
  } else if (active) {
    // Paid cycle running: queue at most one more.
    const { rows: queued } = await client.query(
      "SELECT 1 FROM reward_cycles WHERE player_id = $1 AND status = 'queued' LIMIT 1",
      [playerId]
    );
    if (queued.length > 0) return { started: false, reason: 'queue_full' };
    await createCycle(client, playerId, { kind: 'paid', template, status: 'queued', rechargeEventId });
    return { started: true, status: 'queued', template };
  }

  await createCycle(client, playerId, { kind: 'paid', template, status: 'active', rechargeEventId });
  return { started: true, status: 'active', template };
}

async function findOrCreatePlayer(client, { dosttUserId, mobileNumber }) {
  if (dosttUserId) {
    const { rows } = await client.query(
      `
        INSERT INTO players (dostt_user_id) VALUES ($1)
        ON CONFLICT (dostt_user_id) DO UPDATE SET updated_at = players.updated_at
        RETURNING id
      `,
      [dosttUserId]
    );
    return rows[0].id;
  }
  const { rows } = await client.query('SELECT id FROM players WHERE mobile_number = $1', [mobileNumber]);
  return rows[0]?.id || null;
}

/**
 * Records one recharge (from the webhook or the Redash sync) and starts or
 * queues the matching paid cycle. Re-sending the same externalId is a no-op,
 * except that refunded=true cancels the cycles it created.
 */
export async function recordRecharge({ dosttUserId, mobileNumber, externalId, amountRupees, coins = null, rechargedAt, refunded = false, source }) {
  return runInTransaction(async (client) => {
    const playerId = await findOrCreatePlayer(client, { dosttUserId, mobileNumber });
    if (!playerId) return { status: 'player_not_found' };

    // Serialise all reward changes for this player.
    await client.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);

    const { rows: existing } = await client.query(
      'SELECT id, refunded FROM recharge_events WHERE external_id = $1',
      [externalId]
    );

    if (refunded) {
      if (!existing[0] || existing[0].refunded) return { status: 'ignored' };
      await client.query('UPDATE recharge_events SET refunded = TRUE WHERE id = $1', [existing[0].id]);
      const { rows: cancelled } = await client.query(
        `
          UPDATE reward_cycles SET status = 'cancelled', ended_at = NOW()
          WHERE recharge_event_id = $1 AND status IN ('active', 'queued')
          RETURNING status
        `,
        [existing[0].id]
      );
      if (cancelled.length > 0) await promoteQueued(client, playerId);
      return { status: 'refunded', cyclesCancelled: cancelled.length };
    }

    if (existing[0]) return { status: 'duplicate' };

    const { rows } = await client.query(
      `
        INSERT INTO recharge_events (player_id, external_id, amount_rupees, coins, recharged_at, source)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [playerId, externalId, amountRupees, coins, rechargedAt || new Date(), source]
    );
    await client.query('UPDATE players SET is_payer = TRUE WHERE id = $1', [playerId]);

    const cycle = await startCycleForRecharge(client, playerId, rows[0].id, amountRupees);
    return { status: 'recorded', cycle };
  });
}

export async function resetPlayerRewards(client, playerId) {
  await client.query('DELETE FROM reward_cycles WHERE player_id = $1', [playerId]);
  await client.query('DELETE FROM recharge_events WHERE player_id = $1', [playerId]);
  await client.query('DELETE FROM player_scores WHERE player_id = $1', [playerId]);
  await client.query('UPDATE players SET is_payer = FALSE WHERE id = $1', [playerId]);
}

export async function getRewardEngineStats() {
  const { rows: cycles } = await runQuery(`
    SELECT kind, template, status, COUNT(*)::int AS count
    FROM reward_cycles
    GROUP BY kind, template, status
    ORDER BY kind, template, status
  `);
  const { rows: payouts } = await runQuery(`
    SELECT r.kind, r.template,
           COUNT(DISTINCT r.player_id)::int AS players,
           COALESCE(SUM(s.coin_value), 0)::int AS coins_awarded
    FROM reward_cycles r
    LEFT JOIN spin_events s ON s.cycle_id = r.id
    GROUP BY r.kind, r.template
    ORDER BY r.kind, r.template
  `);
  const { rows: segments } = await runQuery(`
    SELECT segment, COUNT(*)::int AS players,
           COUNT(*) FILTER (WHERE single_spinner)::int AS single_spinners
    FROM player_scores
    GROUP BY segment
    ORDER BY players DESC
  `);
  const { rows: lastRun } = await runQuery(
    'SELECT ran_at, status, dry_run, summary, error FROM reward_scoring_runs ORDER BY ran_at DESC LIMIT 1'
  );
  return {
    enabled: isRewardEngineEnabled(),
    settings: settings(),
    cycles,
    payouts,
    segments,
    lastScoringRun: lastRun[0] || null
  };
}
