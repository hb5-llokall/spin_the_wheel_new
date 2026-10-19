-- Personalised reward engine: per-user cycles of pre-shuffled prize cards.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS is_payer BOOLEAN NOT NULL DEFAULT FALSE;

-- A recharge reported by Dostt (webhook or Redash sync). external_id makes
-- re-delivery of the same recharge a no-op.
CREATE TABLE IF NOT EXISTS recharge_events (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL UNIQUE,
  amount_rupees NUMERIC(10, 2) NOT NULL,
  coins INTEGER,
  recharged_at TIMESTAMPTZ NOT NULL,
  refunded BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recharge_events_player
  ON recharge_events (player_id, recharged_at);

-- status: active | queued | completed | expired | cancelled | superseded
CREATE TABLE IF NOT EXISTS reward_cycles (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  template TEXT NOT NULL,
  cap_coins INTEGER NOT NULL,
  status TEXT NOT NULL,
  recharge_event_id BIGINT REFERENCES recharge_events(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one active cycle per player.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_cycles_one_active
  ON reward_cycles (player_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_reward_cycles_player_status
  ON reward_cycles (player_id, status);

CREATE TABLE IF NOT EXISTS reward_cards (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES reward_cycles(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  position INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  drawn_at TIMESTAMPTZ,
  UNIQUE (cycle_id, day, position)
);

CREATE INDEX IF NOT EXISTS idx_reward_cards_undrawn
  ON reward_cards (cycle_id, day, position)
  WHERE drawn_at IS NULL;

-- Which cycle paid out each spin (NULL for legacy and forced tester spins).
ALTER TABLE spin_events
  ADD COLUMN IF NOT EXISTS cycle_id BIGINT REFERENCES reward_cycles(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS player_scores (
  player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  segment TEXT NOT NULL,
  days_played INTEGER NOT NULL,
  days_played_14d INTEGER NOT NULL,
  avg_spins_per_day NUMERIC(8, 2) NOT NULL,
  days_since_last_spin INTEGER,
  usual_gap_days NUMERIC(6, 2),
  coins_won INTEGER NOT NULL,
  coins_transferred INTEGER NOT NULL,
  single_spinner BOOLEAN NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reward_scoring_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  summary JSONB,
  error TEXT
);
