ALTER TABLE players
  ADD COLUMN IF NOT EXISTS must_recharge_to_spin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS recharge_gate_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_players_must_recharge
  ON players (must_recharge_to_spin)
  WHERE must_recharge_to_spin = TRUE;

CREATE TABLE IF NOT EXISTS recharge_gate_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  summary JSONB,
  error TEXT
);
