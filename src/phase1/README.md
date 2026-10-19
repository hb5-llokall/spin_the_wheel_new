# Phase-1 reward engine (switched off)

Unpaid trial, paid flat / tier plans and the recharge webhook from phase 1.
Replaced by the v1 personalised engine (`src/reward-engine.js`, SPEC in
`docs/spin_reward_handoff/SPEC.md`) and **not imported anywhere**. The code is kept
for reference until the paid-plan ideas are revisited. The `register-recharge-webhook.js`
route is not mounted, and the tables from `sql/add_reward_engine.sql` are no longer created
on boot.
