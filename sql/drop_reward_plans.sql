-- Undo sql/add_reward_plans.sql. Deletes all plans and cards.
DROP INDEX IF EXISTS idx_spin_events_plan;
ALTER TABLE spin_events DROP COLUMN IF EXISTS plan_id;
ALTER TABLE players DROP COLUMN IF EXISTS reward_segment;
DROP TABLE IF EXISTS reward_plan_cards;
DROP TABLE IF EXISTS reward_plans;
DROP TABLE IF EXISTS reward_runs;
