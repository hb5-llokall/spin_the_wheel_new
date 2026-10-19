CREATE TABLE IF NOT EXISTS players (
  id BIGSERIAL PRIMARY KEY,
  mobile_number TEXT NOT NULL UNIQUE,
  display_name TEXT,
  total_coins INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spin_events (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reward_key TEXT NOT NULL,
  reward_label TEXT NOT NULL,
  coin_value INTEGER NOT NULL DEFAULT 0,
  spin_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_requests (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  coins_requested INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  notes TEXT,
  error_message TEXT,
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spin_events_player_date
  ON spin_events(player_id, spin_date);

CREATE INDEX IF NOT EXISTS idx_transfer_requests_player_status
  ON transfer_requests(player_id, status);
