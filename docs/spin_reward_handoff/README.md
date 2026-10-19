# Spin & Win personalised rewards — handoff pack

| File | What it is |
|---|---|
| `CLAUDE_CODE_PROMPT.md` | Prompt to paste into Claude Code to implement the logic in the codebase |
| `SPEC.md` | The full logic in one place: definitions, scoring, reward rule, deck, safety, acceptance criteria |
| `reference_python/reward_logic_reference.py` | Pure-function reference implementation (scoring, share, budget, deck, cards, arm) |
| `reference_python/test_reward_logic_reference.py` | Tests for the reference (run: `pytest`) |
| `examples/golden_share_and_coins.csv` | Expected share and coins for sample scores (median 46, 131 coins/share) |
| `reference_sql/rewards_per_user_same_budget_bq.sql` | BigQuery: per-user score, coins and 5-day plan (July validation) |
| `reference_sql/score_distribution_bq.sql` | BigQuery: users per score (distribution curve) |

How to use:
1. Copy this folder into the Spin & Win repo, e.g. `docs/spin_reward_handoff/`.
2. Open Claude Code in the repo root and paste the prompt from `CLAUDE_CODE_PROMPT.md`.
3. Review its plan before it writes code; then review the diff and test results.
