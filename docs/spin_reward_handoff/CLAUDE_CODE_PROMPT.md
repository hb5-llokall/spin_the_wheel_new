# Prompt for Claude Code

Copy everything below the line into Claude Code, run from the root of the Spin & Win repository,
with this handoff folder copied into the repo (e.g. `docs/spin_reward_handoff/`).

---

You are working on the **Dostt Spin & Win** service (web page opened from the Dostt app; users get
3 free spins a day and transfer won coins to their Dostt wallet). The repo already contains a
**phase-1 reward engine** (personal plans, 90-coin trial, paid plans, new wheel, nightly grouping,
admin view, recharge webhook) that is **written, untested and switched off** (`REWARD_ENGINE=off`).

Your task: **update that engine to the new reward logic** described in
`docs/spin_reward_handoff/SPEC.md`, using `docs/spin_reward_handoff/reference_python/` as the
behavioural reference.

## Read first
1. `docs/spin_reward_handoff/SPEC.md` — the full logic (source of truth).
2. `docs/spin_reward_handoff/reference_python/reward_logic_reference.py` + its tests — exact behaviour.
3. `docs/spin_reward_handoff/reference_sql/*.sql` — the BigQuery queries the logic was validated with.
4. The existing engine code: find the nightly job, plan/deck generation, wheel card serving,
   admin view, recharge webhook, config/feature flags, models/migrations and existing tests.

Before writing code, give me a short plan: which files you'll change or add, how features are
fetched (which DB/tables, read replica or warehouse), and anything in the spec that conflicts
with the current code. Wait for my OK.

## What to build
1. **Feature extraction** for regular payers as of scoring date S (IST windows exactly as in the spec).
   Prefer a read replica / analytics source; batch queries; never query per user in a loop.
2. **Scoring** (`money`, `calls`, `shopping`, `wallet`, `profile`, `total`) — pure functions, identical
   to the reference.
3. **Population params**: median score and `coins_per_share = 90 × N / Σshare` over the whole
   regular-payer population each night; store them per run.
4. **Reward**: share (asymmetric median rule), total coins (round to 5, clamp 10–600).
5. **Deck + cards**: 5-day back-loaded split, every day makeable with ≤3 prizes from {10,15,20,50},
   3 cards/day shuffled once with a deterministic seed and **persisted**.
6. **Segments**: one-time payers, unpaid users and the 10% holdout get the **legacy deck
   [10,10,10,10,50]**. Keep this pluggable so other segments can get their own scoring later.
7. **Experiment arm** via deterministic hash; store the arm on each plan.
8. **Nightly job**: only users whose plan has ended get a new plan; running plans never change.
   Apply the daily coin cap (scale tonight's plans down proportionally if exceeded).
9. **Flags**: `REWARD_ENGINE=off|dry_run|on`. `dry_run` computes, stores and logs everything but
   keeps serving legacy rewards.
10. **Config**: all numbers in the spec's CONFIG (budget per user, ranges, floors, min/max, deck
    weights, prizes, holdout %, daily cap) in one config place, not hard-coded.
11. **Admin/report**: per run — population size, median, coins_per_share, planned coins vs budget
    (%), coins by score band, arm counts; per user — score breakdown, share, coins, deck.
12. **Wheel display**: only winnable prizes; remove display-only prizes (legal requirement).

## Tests (must pass)
- Port `reference_python/test_reward_logic_reference.py` and the golden CSV into the project's test suite.
- Add tests for: factor levels at each boundary, missing data (no calls, no previous pack),
  budget neutrality (±3%), deck makeability for every total 10–600, card persistence (same cards on
  reload), plan immutability, holdout/legacy path, flag behaviour (off / dry_run / on), daily cap.
- An integration/dry-run test for one historical date if test data access allows.

## Constraints
- Don't change behaviour while `REWARD_ENGINE=off`.
- No breaking changes to the transfer flow (`transfer_requests`) or the app-facing API without telling me.
- Migrations must be reversible.
- Keep the scoring code free of I/O so it can be unit tested.
- Ask me before guessing on anything ambiguous (e.g. which DB to read features from, how to map
  `country`, where `booking_talktime`-equivalent data lives in production).

When done: summary of changes, how to run the dry run, test results, and open questions.
