-- Personalised reward engine v1 (docs/spin_reward_handoff/SPEC.md).
-- Undo: sql/drop_reward_plans.sql

-- One row per nightly run.
CREATE TABLE IF NOT EXISTS reward_runs (
  id BIGSERIAL PRIMARY KEY,
  scoring_date DATE NOT NULL,
  plan_start_date DATE NOT NULL,
  mode TEXT NOT NULL,                       -- dry_run | on
  status TEXT NOT NULL,                     -- running | success | failed
  population_size INTEGER,
  median_score NUMERIC(6, 2),
  coins_per_share NUMERIC(12, 4),
  budget_coins INTEGER,
  new_plans INTEGER,
  planned_coins INTEGER,
  summary JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- One 5-spin-day plan per player at a time. Its rewards never change after
-- creation; only the spin-day counter and ended_at move.
-- mode = live (served) or shadow (dry run: drawn alongside, never served).
CREATE TABLE IF NOT EXISTS reward_plans (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  run_id BIGINT REFERENCES reward_runs(id) ON DELETE SET NULL,   -- NULL: legacy plan given at spin time
  mode TEXT NOT NULL,
  segment TEXT NOT NULL,
  arm TEXT,
  features JSONB,
  scores JSONB,                             -- money, calls, shopping, wallet, profile, total
  median_score NUMERIC(6, 2),
  share NUMERIC(8, 6),
  coins_per_share NUMERIC(12, 4),
  scored_coins INTEGER,                     -- before the daily cap
  total_coins INTEGER NOT NULL,
  deck INTEGER[] NOT NULL,
  engine_version TEXT NOT NULL,
  start_date DATE NOT NULL,                 -- day the plan was made (not when day 1 starts)
  spin_days INTEGER NOT NULL DEFAULT 0,     -- days the player has spun on this plan
  last_spin_date DATE,
  ended_at TIMESTAMPTZ,                     -- set once the last spin day is over
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one open plan per player and mode.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_plans_one_open
  ON reward_plans (player_id, mode)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reward_plans_player
  ON reward_plans (player_id, mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_plans_run
  ON reward_plans (run_id);

-- The 3 cards of each plan day, shuffled once at creation. coins = 0 is Better Luck.
CREATE TABLE IF NOT EXISTS reward_plan_cards (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES reward_plans(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  position INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  drawn_at TIMESTAMPTZ,
  UNIQUE (plan_id, day, position)
);

CREATE INDEX IF NOT EXISTS idx_reward_plan_cards_undrawn
  ON reward_plan_cards (plan_id, day, position)
  WHERE drawn_at IS NULL;

-- Recharge segment from the latest nightly run (regular_payer, one_time_payer,
-- unpaid; NULL = not seen yet). Decides what a spin does without an open plan.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS reward_segment TEXT;

-- Which plan paid out each spin (NULL for legacy-rule and forced tester spins).
ALTER TABLE spin_events
  ADD COLUMN IF NOT EXISTS plan_id BIGINT REFERENCES reward_plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_spin_events_plan
  ON spin_events (plan_id) WHERE plan_id IS NOT NULL;
