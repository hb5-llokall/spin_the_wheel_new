# Spin & Win: Personalised Reward Engine — Specification (v1, regular payers)

## 1. Purpose
Today every Spin & Win user gets the same reward: one fixed win per spin day,
**10 coins, and 50 on every 5th day = 90 coins per 5-day cycle**.

v1 keeps the **same total spend (90 coins × users)** but distributes it by a
**behaviour score**: users near the **median** score get the most; users below the
median get a little less; users above the median get much less.

Scope of v1: **regular payers only**. Everyone else (one-time payers, unpaid users,
holdout) keeps the **legacy 90-coin deck** until their scoring is finalised.

## 2. Definitions
| Term | Definition |
|---|---|
| Timezone | All dates are **IST** (Asia/Kolkata) |
| S | Scoring date (the nightly run scores "as of end of S") |
| Recharge | `payments_order` with `type = 1`, `status = 1`, `amount > 0` (no payment-gateway filter). Date = `finalised_on` in IST |
| Spin coins | `payments_order` with `type = 2`, `status = 1`, whose `metadata.bulk_upload_id` belongs to a `common_bulkupload` whose `name` contains "spin" |
| Spin-active | Received spin coins on any day in **[S-6, S]** |
| Regular payer | Spin-active **and** 2+ recharges in **[S-29, S]** |
| One-time payer | Spin-active and exactly 1 recharge in [S-29, S] — *v1: legacy deck* |
| Unpaid | Spin-active and 0 recharges — *v1: legacy deck* |
| Connected call | `bookings_booking` with `started_at` not null and `ended_at > started_at` (or ETL `booking_talktime`) |
| User id | `payments_order.customer_id` = `bookings_booking.customer_id` = `users_user.id` = Spin `players.dostt_user_id` |

## 3. Score (0–100) — regular payers
| Section | Factor | Data / window | Levels → points |
|---|---|---|---|
| **Money (40)** | AOV | median recharge amount (ex-GST), [S-29,S] | <₹50 → 3 · <₹150 → 5 · <₹500 → 9 · ≥₹500 → 13 |
| | Frequency | # recharges, [S-29,S] | 2 → 4 · 3–4 → 7 · 5–9 → 9 · 10+ → 11 |
| | Due for recharge | days since last recharge ÷ usual gap; gap = (last−first)/(n−1), min 0.5 day | <0.5 → 3 · ≤1.5 → 8 · ≤3 → 4 · >3 → 0 |
| | Pack trend | coins of last vs previous recharge | bigger → 4 · same → 3 · smaller → 0 |
| | Offer use | share of recharges with `offer_id` | <25% → 4 · ≤75% → 3 · >75% → 0 |
| **Calls (35)** | Minutes | connected talktime, [S-6,S] | 0 → 0 · <15 → 4 · <60 → 8 · <180 → 11 · ≥180 → 14 |
| | Call trend | minutes [S-6,S] vs [S-13,S-7] | none both weeks → 0 · last week 0 → 8 · ≥1.2× → 8 · ≥0.8× → 5 · else 1 |
| | Video share | video minutes ÷ minutes, [S-6,S] (video part only) | 0 → 0 · <25% → 3 · <50% → 6 · ≥50% → 7 |
| | Repeat listener | max calls to one expert, [S-6,S] | ≥3 → 6 · 2 → 3 · else 0 |
| **Shopping (15)** | Unfinished payment attempts | type 1, status 0/2/3/4, initiated [S-6,S] | ≥2 → 15 · 1 → 9 · 0 → 0 |
| **Wallet (5)** | Ran out of coins | calls in [S-6,S] with `final_customer_balance < coins_per_minute` | ≥2 → 5 · else 0 |
| **Profile (5)** | Platform | onboarded platform | iOS → 2 · else 0 |
| | Country | onboarded country | outside India → 2 · India/unknown → 0 |
| | Account age | days since signup to S | ≥90 → 1 · else 0 |

Spin activity is **not scored** (it gave nearly everyone the same points). Package-page views are not yet available.

## 4. Reward
1. **Population**: all regular payers scored tonight.
2. **median_score** = median of their total scores.
3. **share** per user:
   - score ≤ median: `max(1 − (median − score)/96, 0.2)`
   - score > median: `max(1 − (score − median)/25, 0.1)`
4. **Budget** = `90 × N_population` coins.
   **coins_per_share** = budget ÷ Σ share (over the whole population).
5. **total_coins** = `round(share × coins_per_share / 5) × 5`, clamp to **[10, 600]**.
   Only users whose plan ends tonight get a new plan, but `median_score` and
   `coins_per_share` always come from the **whole** population (so the average stays 90).

Illustration (July data: median 46, coins_per_share ≈ 131):
score 20 → 95 · 30 → 110 · **46 → 130** · 60 → 60 · 70+ → 15.

## 5. 5-day deck
- Split: Day1–4 = floor(total × 10% / 15% / 20% / 25%) to a multiple of 5 (0 if < 10); Day5 = rest.
- Every day amount must be **makeable with ≤ 3 prizes from {10, 15, 20, 50}** (makeable set:
  0,10–90 in 5s, 100, 110, 115, 120, 150). If not makeable or > 150, push the excess to the
  previous day; Day1 excess goes to the latest day that can absorb it (≤ 5 coins may be lost, rare).
- Examples: 10 → [0,0,0,0,10] · 80 → [0,10,15,20,35] · 130 → [10,15,25,30,50] · 205 → [20,30,40,50,65].
- Each day = **3 cards** (its prizes + "Better Luck"), **shuffled once with a deterministic seed and stored**.
- Missed spins carry over within the plan. After the plan ends, spins land on "Better Luck" until the
  next plan is assigned (next nightly run).
- Wheel shows only winnable prizes (Better Luck, 10, 15, 20, 50; 500 only in VIP plans, not used in v1).

## 6. Experiment & safety
- **Arms** (deterministic hash of user_id): 10% `holdout_legacy_90` (today's deck), 90% `median_low_favoured`.
  Store the arm on every plan.
- **Feature flag** `REWARD_ENGINE` = `off` | `dry_run` (compute + store + log, serve legacy) | `on`.
- **Daily coin cap** (config): if tonight's new plans exceed it, scale all of tonight's plans down proportionally.
- **Never change a running plan.** Re-score only when a plan ends.
- Store per plan: user_id, arm, score + section scores, median_score, share, coins_per_share,
  total_coins, deck, cards, engine version, created_at.
- Admin/report: total planned coins vs budget, coins by score band, redeemed vs planned.

## 7. Acceptance criteria
- Unit tests match `reference_python/` (golden examples in `examples/golden_share_and_coins.csv`).
- Dry run on a July date reproduces `reference_sql/rewards_per_user_same_budget_bq.sql` within rounding.
- Total planned coins within ±3% of 90 × population each night.
- No served day amount outside the makeable set; no card ever shows a non-winnable prize.

## 8. Known caveats
- The score predicts who is valuable, not who responds to rewards; the pilot (with holdout) decides.
- Top scorers drop from 90 to ~15 coins in this shape: monitor their revenue; raise `high_floor` if needed.
- Real spend < planned, because users skip days.
